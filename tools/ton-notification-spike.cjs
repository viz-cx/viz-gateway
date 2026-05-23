// SPIKE: verify the TEP-74 transfer_notification parser the ton-watcher uses to
// detect peg-out deposits (wVIZ sent to the gateway Jetton wallet with a comment
// = the user's VIZ account). Constructs the cell both ways the standard allows
// (forward_payload inline vs. in a ref) and checks the parse round-trips.
//
// Run: node tools/ton-notification-spike.cjs
const assert = require("node:assert");
const { beginCell, Address } = require("@ton/ton");
const { parseTransferNotification } = require("../packages/ton-watcher/dist/tonChain.js");

const SENDER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const AMOUNT = 1068237n; // base units == milli-VIZ at 3 decimals (1068.237 wVIZ)
const COMMENT = "alice"; // the user's VIZ destination account

function buildCommentCell(text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

// Variant A: forward_payload inline (Either bit = 0)
const inlineBody = beginCell()
  .storeUint(0x7362d09c, 32) // transfer_notification
  .storeUint(0, 64) // query_id
  .storeCoins(AMOUNT)
  .storeAddress(Address.parse(SENDER))
  .storeBit(0) // inline
  .storeUint(0, 32) // comment tag
  .storeStringTail(COMMENT)
  .endCell();

// Variant B: forward_payload in a ref (Either bit = 1)
const refBody = beginCell()
  .storeUint(0x7362d09c, 32)
  .storeUint(0, 64)
  .storeCoins(AMOUNT)
  .storeAddress(Address.parse(SENDER))
  .storeBit(1) // ref
  .storeRef(buildCommentCell(COMMENT))
  .endCell();

for (const [label, body] of [["inline", inlineBody], ["ref", refBody]]) {
  const p = parseTransferNotification(body.beginParse());
  assert.ok(p, `${label}: parser returned null`);
  assert.strictEqual(p.amountBaseUnits, AMOUNT, `${label}: amount`);
  assert.strictEqual(p.sender, Address.parse(SENDER).toString(), `${label}: sender`);
  assert.strictEqual(p.comment, COMMENT, `${label}: comment`);
  console.log(`[${label}] amount=${p.amountBaseUnits} sender=${p.sender.slice(0, 10)}.. comment="${p.comment}" OK`);
}

// Negative: a non-notification op must be ignored.
const other = beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64).endCell();
assert.strictEqual(parseTransferNotification(other.beginParse()), null);
console.log("[negative] non-notification op ignored OK");

console.log("\nRESULT: transfer_notification parser round-trips for both payload");
console.log("encodings and rejects unrelated ops. Peg-out detection parsing is sound.");
