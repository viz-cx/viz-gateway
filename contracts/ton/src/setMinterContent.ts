import { Address, Cell, internal, SendMode, toNano } from "@ton/core";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { loadDeployConfig } from "./config";
import { changeContentBody } from "./minter";
import { buildWvizContent, parseWvizContent } from "./metadata";
import { Multisig, type TransferRequest } from "./wrappers/Multisig";
import { Order } from "./wrappers/Order";

/**
 * Update the wVIZ Jetton minter's on-chain metadata (change_content#4) — the
 * lever for setting/fixing the token image (WVIZ_IMAGE) or any other TEP-64 field
 * on an ALREADY-DEPLOYED minter whose admin is the federation multisig.
 *
 * A fresh minter does NOT need this: WVIZ_IMAGE is baked into the content cell at
 * `deploy:minter` time. This tool exists for a minter already handed off to the
 * multisig (testnet, or mainnet post-launch), where only an M-of-N order can call
 * an admin op.
 *
 * Flow (mirrors rotate:ton): the proposer runs `submit`, shares the printed order
 * address, and each other signer runs `approve <order>`. Every approver rebuilds
 * the expected content cell from its OWN WVIZ_* env and refuses to approve unless
 * the on-chain order matches byte-for-byte — so the coordinator can't slip a
 * different metadata past the federation. At threshold the order self-executes.
 *
 * Env: MINTER_ADDRESS, MULTISIG_ADDRESS (the admin), WVIZ_* (the desired metadata),
 * TON_SIGNER_MNEMONIC (your operator wallet), TON_ENDPOINT/TON_API_KEY.
 */

const ORDER_TTL_SEC = Number.parseInt(process.env.TON_ORDER_TTL_SEC || "172800", 10); // 48h

/** Value attached to the new_order message; must be covered by the proposer wallet. */
const NEW_ORDER_VALUE = toNano("1");
/** Gas headroom on top of NEW_ORDER_VALUE so the proposer wallet can also pay its own fees. */
const PROPOSER_GAS_HEADROOM = toNano("0.05");

/** The single multisig action: send change_content to the minter as the admin. */
function contentAction(minter: Address, content: Cell): TransferRequest {
  return {
    type: "transfer",
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    message: internal({ to: minter, value: toNano("0.1"), body: changeContentBody(content) }),
  };
}

/** The packed order cell operators independently recompute and compare before approving. */
function packContentOrder(minter: Address, content: Cell): Cell {
  return Multisig.packOrder([contentAction(minter, content)]);
}

function client(cfg: ReturnType<typeof loadDeployConfig>): TonClient {
  return new TonClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey || undefined, timeout: 15000 });
}

async function signerWallet(): Promise<{ wallet: WalletContractV4; secretKey: Buffer }> {
  const mnemonic = (process.env.TON_SIGNER_MNEMONIC || "").trim();
  if (!mnemonic) throw new Error("TON_SIGNER_MNEMONIC (your operator TON wallet) is required");
  const kp = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
  return { wallet: WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }), secretKey: kp.secretKey };
}

/** Rebuild the desired content cell from WVIZ_* env and print what it contains. */
function desiredContent(cfg: ReturnType<typeof loadDeployConfig>): Cell {
  const content = buildWvizContent(cfg.wviz);
  const parsed = parseWvizContent(content);
  console.log(`[set-minter-content] desired metadata:`);
  for (const k of ["name", "symbol", "decimals", "description", "image"]) {
    console.log(`  ${k.padEnd(11)}: ${parsed[k] ?? "(unset)"}`);
  }
  if (!parsed.image) {
    console.warn("[set-minter-content] WARNING: image is empty — set WVIZ_IMAGE to a stable https/ipfs URL.");
  }
  return content;
}

async function submit(): Promise<void> {
  const cfg = loadDeployConfig();
  if (!cfg.minterAddress) throw new Error("Set MINTER_ADDRESS.");
  if (!cfg.multisigAddress) throw new Error("Set MULTISIG_ADDRESS (the minter's admin).");
  const apply = process.env.APPLY === "1";

  const minter = Address.parse(cfg.minterAddress);
  const multisigAddr = Address.parse(cfg.multisigAddress);
  const content = desiredContent(cfg);
  const order = packContentOrder(minter, content);
  console.log(`[set-minter-content] minter     : ${minter.toString()}`);
  console.log(`[set-minter-content] multisig   : ${multisigAddr.toString()}`);
  console.log(`[set-minter-content] order hash : ${order.hash().toString("hex")}`);

  const c = client(cfg);
  const data = await c.open(Multisig.createFromAddress(multisigAddr)).getMultisigData();
  const { wallet, secretKey } = await signerWallet();
  const myIdx = data.signers.findIndex((s) => s.equals(wallet.address));
  if (myIdx < 0) throw new Error(`your wallet ${wallet.address.toString()} is not a current multisig signer`);

  const orderAddr = await c.open(Multisig.createFromAddress(multisigAddr)).getOrderAddress(data.nextOrderSeqno);

  // Pre-flight the proposer balance: sendNewOrder attaches NEW_ORDER_VALUE and the
  // wallet also pays its own gas. If the wallet can't cover it, the new_order never
  // leaves the wallet and no order is created — but the raw send would still "succeed"
  // client-side. Fail closed here so the operator isn't told they proposed when they didn't.
  const balance = await c.getBalance(wallet.address);
  const required = NEW_ORDER_VALUE + PROPOSER_GAS_HEADROOM;
  const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(4);
  console.log(`[set-minter-content] proposer   : ${wallet.address.toString()} (${fmt(balance)} TON)`);
  if (balance < required) {
    throw new Error(
      `proposer wallet ${wallet.address.toString()} has ${fmt(balance)} TON but needs ` +
        `≥ ${fmt(required)} TON (${fmt(NEW_ORDER_VALUE)} new_order value + ${fmt(PROPOSER_GAS_HEADROOM)} gas). ` +
        `Fund it before submitting — otherwise the new_order silently dies in the wallet and no order is created.`,
    );
  }

  if (!apply) {
    console.log(`[set-minter-content] order seqno ${data.nextOrderSeqno}, address ${orderAddr.toString()}`);
    console.log("[set-minter-content] DRY-RUN. Set APPLY=1 to send the new_order.");
    return;
  }

  // sendNewOrder needs configuration for the auto-detect signer path; rebuild it from on-chain data.
  const multisig = c.open(
    new Multisig(multisigAddr, undefined, {
      threshold: Number(data.threshold),
      signers: data.signers,
      proposers: data.proposers,
      allowArbitrarySeqno: false,
    }),
  );
  const expiration = Math.floor(Date.now() / 1000) + ORDER_TTL_SEC;
  const sender = c.open(wallet).sender(secretKey);
  await multisig.sendNewOrder(sender, [contentAction(minter, content)], expiration, NEW_ORDER_VALUE, myIdx, true);
  console.log(`[set-minter-content] sent. Order address: ${orderAddr.toString()}`);
  console.log(`[set-minter-content] share it; each other signer runs: set:minter-content approve ${orderAddr.toString()}`);
}

async function approve(): Promise<void> {
  const cfg = loadDeployConfig();
  const orderArg = process.argv[3];
  const apply = process.env.APPLY === "1";
  if (!orderArg) throw new Error("approve needs the order address (set:minter-content approve <order-address>)");
  if (!cfg.minterAddress) throw new Error("Set MINTER_ADDRESS.");

  const minter = Address.parse(cfg.minterAddress);
  const expectedOrder = packContentOrder(minter, desiredContent(cfg));

  const c = client(cfg);
  const order = c.open(Order.createFromAddress(Address.parse(orderArg)));
  const od = await order.getOrderData();
  if (od.executed) {
    console.log("[set-minter-content] order already executed — nothing to do.");
    return;
  }
  if (!od.order) throw new Error("order not initialized yet (proposer must submit first)");

  // Trust-critical: the on-chain order must be EXACTLY the content change we expect.
  if (!od.order.equals(expectedOrder)) {
    throw new Error("on-chain order does not match the expected change_content (tampered, stale, or different WVIZ_* env)");
  }

  const { wallet, secretKey } = await signerWallet();
  const myIdx = od.signers.findIndex((s) => s.equals(wallet.address));
  if (myIdx < 0) throw new Error(`your wallet ${wallet.address.toString()} is not a signer on this order`);
  if (od.approvals[myIdx]) {
    console.log("[set-minter-content] you already approved this order.");
    return;
  }
  if (od.expiration_date !== null && od.expiration_date < BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error(`order expired at ${new Date(Number(od.expiration_date) * 1000).toISOString()}`);
  }
  const approved = od.approvals_num ?? od.approvals.filter(Boolean).length;
  console.log(`[set-minter-content] order validated; ${approved}/${od.threshold ?? "?"} approved; your signer index ${myIdx}`);
  if (!apply) {
    console.log("[set-minter-content] DRY-RUN. Set APPLY=1 to send your on-chain approve.");
    return;
  }
  const sender = c.open(wallet).sender(secretKey);
  await order.sendApprove(sender, myIdx);
  console.log("[set-minter-content] approve sent. At threshold the order auto-executes and the metadata updates.");
}

async function status(): Promise<void> {
  const cfg = loadDeployConfig();
  if (!cfg.minterAddress) throw new Error("Set MINTER_ADDRESS.");
  const minter = Address.parse(cfg.minterAddress);
  const expected = parseWvizContent(buildWvizContent(cfg.wviz));

  // The minter's live content isn't a cheap getter here; report the desired target and
  // let the operator diff against an explorer. (parseWvizContent is used by e2e:gram:metadata.)
  console.log(`[set-minter-content] minter ${minter.toString()}`);
  console.log(`[set-minter-content] desired image: ${expected.image || "(unset — set WVIZ_IMAGE)"}`);
  console.log("[set-minter-content] verify the on-chain value with: npm run e2e:gram:metadata");
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "submit") return submit();
  if (sub === "approve") return approve();
  if (sub === "status") return status();
  throw new Error(`unknown subcommand: ${sub ?? ""} (use submit | approve <order> | status)`.trim());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
