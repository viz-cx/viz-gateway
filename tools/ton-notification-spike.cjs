// SPIKE: verify the TEP-74 inbound-jetton parser the ton-watcher uses to detect
// peg-out deposits (wVIZ sent to the gateway Jetton wallet with a comment = the
// user's VIZ account). The gateway jetton wallet actually receives internal_transfer
// (0x178d4519); transfer_notification (0x7362d09c) is what a wallet emits to its owner.
// parseJettonDeposit accepts both. Constructs each with forward_payload inline vs. ref.
//
// Run: node tools/ton-notification-spike.cjs
const assert = require("node:assert");
const { beginCell, Address } = require("@ton/ton");
const { parseJettonDeposit } = require("../packages/ton-watcher/dist/tonChain.js");

const SENDER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const AMOUNT = 1068237n; // base units == milli-VIZ at 3 decimals (1068.237 wVIZ)
const COMMENT = "alice"; // the user's VIZ destination account

function buildCommentCell(text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

// transfer_notification (0x7362d09c): query_id, amount, sender, forward_payload.
function notification(payloadInRef) {
  const b = beginCell().storeUint(0x7362d09c, 32).storeUint(0, 64).storeCoins(AMOUNT).storeAddress(Address.parse(SENDER));
  return payloadInRef
    ? b.storeBit(1).storeRef(buildCommentCell(COMMENT)).endCell()
    : b.storeBit(0).storeUint(0, 32).storeStringTail(COMMENT).endCell();
}

// internal_transfer (0x178d4519): adds response_address + forward_ton_amount before
// the forward_payload. This is what the gateway's OWN jetton wallet actually receives.
function internalTransfer(payloadInRef) {
  const b = beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(0, 64)
    .storeCoins(AMOUNT)
    .storeAddress(Address.parse(SENDER)) // from
    .storeAddress(Address.parse(SENDER)) // response_address
    .storeCoins(50000000n); // forward_ton_amount
  return payloadInRef
    ? b.storeBit(1).storeRef(buildCommentCell(COMMENT)).endCell()
    : b.storeBit(0).storeUint(0, 32).storeStringTail(COMMENT).endCell();
}

const cases = [
  ["internal_transfer/inline", internalTransfer(false)],
  ["internal_transfer/ref", internalTransfer(true)],
  ["notification/inline", notification(false)],
  ["notification/ref", notification(true)],
];
for (const [label, body] of cases) {
  const p = parseJettonDeposit(body.beginParse());
  assert.ok(p, `${label}: parser returned null`);
  assert.strictEqual(p.amountBaseUnits, AMOUNT, `${label}: amount`);
  assert.strictEqual(p.sender, Address.parse(SENDER).toString(), `${label}: sender`);
  assert.strictEqual(p.comment, COMMENT, `${label}: comment`);
  console.log(`[${label}] amount=${p.amountBaseUnits} sender=${p.sender.slice(0, 10)}.. comment="${p.comment}" OK`);
}

// Negative: an unrelated op must be ignored.
const other = beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64).endCell();
assert.strictEqual(parseJettonDeposit(other.beginParse()), null);
console.log("[negative] unrelated op ignored OK");

console.log("\nRESULT: parseJettonDeposit round-trips internal_transfer (the real inbound");
console.log("message) AND transfer_notification for both payload encodings; rejects other ops.");
