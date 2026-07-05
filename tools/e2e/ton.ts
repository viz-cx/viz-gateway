// tools/e2e/ton.ts — minimal TON client for the e2e harness (burn submit + wVIZ balance).
import { TonClient, WalletContractV4, internal, Address, beginCell, toNano } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Multisig } from "@gateway/contracts-ton";
import type { E2eConfig } from "./config";

function client(cfg: E2eConfig): TonClient {
  return new TonClient({ endpoint: cfg.gram.endpoint, apiKey: cfg.gram.apiKey });
}

/**
 * Deterministic address of the NEXT multisig order (peg-in mint). Mirrors
 * `GramHttpChain.nextOrderAddress`: the address is a pure function of
 * (multisig, nextOrderSeqno), and the seqno only advances when an order is
 * actually created — so it is a durable idempotency key and, across a crash,
 * a reliable "was a second order created?" counter.
 */
export async function nextOrderInfo(cfg: E2eConfig): Promise<{ orderAddr: string; seqno: bigint }> {
  const c = client(cfg);
  const ms = c.open(Multisig.createFromAddress(Address.parse(cfg.gram.multisigAddress)));
  const data = await ms.getMultisigData();
  const orderAddr = await ms.getOrderAddress(data.nextOrderSeqno);
  return { orderAddr: orderAddr.toString(), seqno: data.nextOrderSeqno };
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
  const state = await client(cfg).getContractState(Address.parse(orderAddr));
  return state.state === "active";
}

/** Jetton wallet address of `owner` under the configured minter. */
async function walletAddressOf(c: TonClient, minter: string, owner: string): Promise<Address> {
  const res = await c.runMethod(Address.parse(minter), "get_wallet_address", [
    { type: "slice", cell: beginCell().storeAddress(Address.parse(owner)).endCell() },
  ]);
  return res.stack.readAddress();
}

export async function tonWvizBalance(cfg: E2eConfig, ownerAddress: string): Promise<bigint> {
  const c = client(cfg);
  const jw = await walletAddressOf(c, cfg.gram.jettonMinterAddress, ownerAddress);
  if (!(await c.isContractDeployed(jw))) return 0n;
  const res = await c.runMethod(jw, "get_wallet_data", []);
  return res.stack.readBigNumber(); // balance is the first field
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
