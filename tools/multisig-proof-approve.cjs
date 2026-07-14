// Multisig liveness proof — STEP 2 (independent approver / op-2 or op-3).
//
// Run this on the OPERATOR'S OWN machine with their OWN mnemonic. It:
//   1. opens the Order contract at ORDER_ADDRESS,
//   2. DECODES and prints the pending actions so the operator can confirm what
//      they are signing (a benign "send 0.02 TON to op-1", not a mint/rotation),
//   3. resolves this operator's signer index from the order's own signer snapshot
//      (tries v4 + v5r1, uses whichever wallet is in the set),
//   4. sends `approve`. When approvals reach the threshold the order self-executes.
//
// Env: TON_ENDPOINT, TON_API_KEY, ORDER_ADDRESS, MNEMONIC (24 words). SEND=1 to broadcast.
const { TonClient, Address, WalletContractV4, WalletContractV5R1, Dictionary, loadMessageRelaxed, fromNano } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");
const { Order } = require("../contracts/ton/dist/wrappers/Order.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_SEND_MESSAGE = 0xf1381e5b;
const OP_UPDATE_PARAMS = 0x1d0cfbd3;

function decodeOrder(orderCell) {
  if (!orderCell) return [];
  const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Cell(), orderCell);
  const out = [];
  for (const [i, cell] of dict) {
    const cs = cell.beginParse();
    const op = cs.loadUint(32);
    if (op === OP_SEND_MESSAGE) {
      const mode = cs.loadUint(8);
      const msg = loadMessageRelaxed(cs.loadRef().beginParse());
      const dest = msg.info && msg.info.dest ? msg.info.dest.toString() : "(unknown)";
      const value = msg.info && msg.info.value ? fromNano(msg.info.value.coins) : "?";
      out.push(`  [${i}] send_message  mode=${mode}  value=${value} TON  -> ${dest}`);
    } else if (op === OP_UPDATE_PARAMS) {
      out.push(`  [${i}] update_multisig_params  (⚠ changes signer set/threshold)`);
    } else {
      out.push(`  [${i}] unknown op 0x${op.toString(16)}`);
    }
  }
  return out;
}

(async () => {
  const endpoint = process.env.TON_ENDPOINT;
  if (!endpoint) throw new Error("TON_ENDPOINT required");
  const orderStr = process.env.ORDER_ADDRESS;
  if (!orderStr) throw new Error("ORDER_ADDRESS required (from step 1 output)");
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error("MNEMONIC (this operator's 24 words) required");

  const client = new TonClient({ endpoint, apiKey: process.env.TON_API_KEY || undefined, timeout: 30000 });
  const orderAddr = Address.parse(orderStr);
  const order = client.open(Order.createFromAddress(orderAddr));

  if ((await client.getContractState(orderAddr)).state !== "active") {
    throw new Error(`order ${orderStr} is not active on-chain (not yet proposed, or wrong address)`);
  }
  const od = await order.getOrderData();

  console.log("order       :", orderStr);
  console.log("multisig    :", od.multisig.toString());
  console.log("threshold   :", od.threshold, " approvals so far:", od.approvals_num);
  console.log("executed    :", od.executed);
  console.log("pending actions:");
  decodeOrder(od.order).forEach((l) => console.log(l));

  const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const pk = kp.publicKey;
  const candidates = [
    WalletContractV4.create({ workchain: 0, publicKey: pk }),
    WalletContractV5R1.create({ workchain: 0, publicKey: pk }),
  ];
  let wallet, myIdx = -1, flavour = "";
  for (const [j, c] of candidates.entries()) {
    const i = od.signers.findIndex((s) => s.equals(c.address));
    if (i >= 0) { wallet = c; myIdx = i; flavour = j === 0 ? "v4" : "v5r1"; break; }
  }
  if (!wallet) throw new Error("your wallet (v4/v5r1) is not in this order's signer set");
  console.log("approver    :", wallet.address.toString(), `(op idx ${myIdx}, ${flavour})`);

  if (od.executed) { console.log("\nalready executed — nothing to do."); return; }
  if (od.approvals[myIdx]) { console.log("\nyou already approved this order (bit set)."); return; }

  if (process.env.SEND !== "1") {
    console.log("\nDRY-RUN (set SEND=1 to broadcast your approve). Review the actions above first.");
    return;
  }

  const sender = client.open(wallet).sender(kp.secretKey);
  await order.sendApprove(sender, myIdx);
  console.log("\napprove sent (idx " + myIdx + "). Polling for reflection / execution...");

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const d = await order.getOrderData();
    if (d.executed) { console.log("EXECUTED ✅ — threshold reached, actions ran."); return; }
    if (d.approvals[myIdx]) { console.log(`approval reflected (${d.approvals_num}/${d.threshold}). Waiting for execution...`); }
    await sleep(4000);
  }
  console.log("timed out after 120s — check the order on an explorer.");
})().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
