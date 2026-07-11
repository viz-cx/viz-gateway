// tools/e2e/ton.ts — minimal TON client for the e2e harness (burn submit + wVIZ balance).
import { TonClient, WalletContractV4, internal, Address, beginCell, toNano, Cell } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Multisig, parseWvizContent } from "@gateway/contracts-ton";
import type { E2eConfig } from "./config";

function client(cfg: E2eConfig): TonClient {
  // Bound each toncenter call. Public testnet toncenter returns slow 504s under load;
  // without a per-call timeout a single hung request blocks a pollUntil() iteration for
  // minutes (TonClient's internal backoff), so the poll can't cycle to catch a recovery
  // window and times out even though the on-chain state is correct. A short ceiling makes
  // a blip fail fast and retry on the next interval — exactly what pollUntil intends.
  return new TonClient({ endpoint: cfg.gram.endpoint, apiKey: cfg.gram.apiKey, timeout: 12_000 });
}

/**
 * Retry a toncenter read a few times before giving up. Public testnet toncenter
 * intermittently 504s or refuses the TCP connection (ETIMEDOUT); a bare read would
 * then throw and abort a criterion that is in fact passing. These reads are pure
 * (idempotent) queries, so retrying is safe and only smooths over transport blips.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 3_000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

/**
 * Deterministic address of the NEXT multisig order (peg-in mint). Mirrors
 * `GramHttpChain.nextOrderAddress`: the address is a pure function of
 * (multisig, nextOrderSeqno), and the seqno only advances when an order is
 * actually created — so it is a durable idempotency key and, across a crash,
 * a reliable "was a second order created?" counter.
 */
export async function nextOrderInfo(cfg: E2eConfig): Promise<{ orderAddr: string; seqno: bigint }> {
  return withRetry(async () => {
    const c = client(cfg);
    const ms = c.open(Multisig.createFromAddress(Address.parse(cfg.gram.multisigAddress)));
    const data = await ms.getMultisigData();
    const orderAddr = await ms.getOrderAddress(data.nextOrderSeqno);
    return { orderAddr: orderAddr.toString(), seqno: data.nextOrderSeqno };
  });
}

/** Current nextOrderSeqno of the gateway multisig — the count of orders ever created. */
export async function nextOrderSeqno(cfg: E2eConfig): Promise<bigint> {
  return (await nextOrderInfo(cfg)).seqno;
}

/**
 * True if a multisig order contract is deployed on-chain (i.e. a new_order landed).
 * Same predicate as `GramHttpChain.orderExists` — existence, not the executed flag.
 */
export async function orderExists(cfg: E2eConfig, orderAddr: string): Promise<boolean> {
  return withRetry(async () => {
    const state = await client(cfg).getContractState(Address.parse(orderAddr));
    return state.state === "active";
  });
}

/** Jetton wallet address of `owner` under the configured minter. */
async function walletAddressOf(c: TonClient, minter: string, owner: string): Promise<Address> {
  const res = await c.runMethod(Address.parse(minter), "get_wallet_address", [
    { type: "slice", cell: beginCell().storeAddress(Address.parse(owner)).endCell() },
  ]);
  return res.stack.readAddress();
}

export async function tonWvizBalance(cfg: E2eConfig, ownerAddress: string): Promise<bigint> {
  return withRetry(async () => {
    const c = client(cfg);
    const jw = await walletAddressOf(c, cfg.gram.jettonMinterAddress, ownerAddress);
    if (!(await c.isContractDeployed(jw))) return 0n;
    const res = await c.runMethod(jw, "get_wallet_data", []);
    return res.stack.readBigNumber(); // balance is the first field
  });
}

/**
 * Current TON balance (nano) held by the wVIZ jetton minter contract. Used to
 * observe per-mint accretion: the standard governed minter has no excess-return
 * on the mint op, so it keeps `attached value − ton_amount − fees` per mint.
 * PR #59 lowered the attached mint value 0.1→0.06 TON; this read lets a live run
 * measure the resulting per-mint delta (~0.049 → ~0.008 TON expected).
 */
export async function minterTonBalance(cfg: E2eConfig): Promise<bigint> {
  return withRetry(async () => {
    const c = client(cfg);
    return c.getBalance(Address.parse(cfg.gram.jettonMinterAddress));
  });
}

export interface MinterData {
  totalSupply: bigint; // circulating wVIZ, base units (mVIZ)
  mintable: boolean;
  admin: string; // friendly address of the current admin (should be the multisig)
  content: Record<string, string>; // parsed TEP-64 on-chain metadata (name/symbol/decimals/description/image)
}

/**
 * Read the deployed wVIZ minter's on-chain state via `get_jetton_data`
 * (standard governed-discoverable layout: total_supply, mintable, admin,
 * jetton_content:^Cell, jetton_wallet_code:^Cell). The content cell is parsed
 * back to a flat record so a live run can assert the deployed metadata matches
 * what buildWvizContent produced — including whether an icon (`image`) is set.
 */
export async function readMinterData(cfg: E2eConfig): Promise<MinterData> {
  return withRetry(async () => {
    const c = client(cfg);
    const res = await c.runMethod(Address.parse(cfg.gram.jettonMinterAddress), "get_jetton_data", []);
    const totalSupply = res.stack.readBigNumber();
    const mintable = res.stack.readBoolean();
    const admin = res.stack.readAddress();
    const content = res.stack.readCell();
    return {
      totalSupply,
      mintable,
      admin: admin.toString(),
      content: parseWvizContent(content as Cell),
    };
  });
}

export async function submitBurn(
  cfg: E2eConfig,
  amountBaseUnits: bigint,
  vizRecipient: string,
): Promise<void> {
  const c = client(cfg);
  const key = await mnemonicToPrivateKey(cfg.gram.burnMnemonic.split(/\s+/));
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  const opened = c.open(wallet);
  const myJetton = await walletAddressOf(c, cfg.gram.jettonMinterAddress, wallet.address.toString());

  // E2E_GRAM_GATEWAY_OWNER is the gateway's owner address; the jetton transfer
  // destination field is the owner (not the jetton wallet address itself).
  const gatewayOwner = Address.parse(cfg.gram.gatewayOwner);
  const comment = beginCell().storeUint(0, 32).storeStringTail(vizRecipient).endCell();
  const transferBody = beginCell()
    .storeUint(0x0f8a7ea5, 32) // TEP-74 transfer
    .storeUint(0n, 64) // query_id
    .storeCoins(amountBaseUnits)
    .storeAddress(gatewayOwner) // destination owner
    .storeAddress(wallet.address) // response destination
    .storeBit(false) // no custom payload
    .storeCoins(toNano("0.05")) // forward_ton_amount (fires transfer_notification)
    .storeBit(true) // forward_payload in ref
    .storeRef(comment)
    .endCell();

  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    seqno,
    secretKey: key.secretKey,
    messages: [internal({ to: myJetton, value: toNano("0.1"), body: transferBody })],
  });
}
