// SPIKE: the VIZ getDeposit transaction_id guard fails CLOSED on a missing id (VG M7).
// The old guard was `if (tx.transaction_id && tx.transaction_id !== trxId) throw` — a node
// that returned an empty/undefined transaction_id skipped the check entirely (fail-open),
// letting a lying node substitute a different transfer under the requested trxId. Exercises
// the extracted assertTransactionIdMatches directly:
//   1) exact match -> ok (no throw).
//   2) mismatch -> throws.
//   3) empty "" -> throws (was the fail-open hole).
//   4) undefined -> throws (was the fail-open hole).
//
// Run: node tools/viz-lying-node-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { assertTransactionIdMatches } = require("../packages/viz-watcher/dist/vizChain");

const TRX = "abc123def";

assert.doesNotThrow(() => assertTransactionIdMatches(TRX, TRX), "matching id passes");
console.log("[viz-lying-node] matching transaction_id passes OK");

assert.throws(() => assertTransactionIdMatches("someOtherTrx", TRX), /!= requested/, "mismatched id throws");
console.log("[viz-lying-node] mismatched transaction_id throws OK");

assert.throws(() => assertTransactionIdMatches("", TRX), /!= requested/, "empty id must FAIL CLOSED (was fail-open)");
console.log("[viz-lying-node] empty transaction_id fails closed OK");

assert.throws(() => assertTransactionIdMatches(undefined, TRX), /!= requested/, "undefined id must FAIL CLOSED (was fail-open)");
console.log("[viz-lying-node] undefined transaction_id fails closed OK");

console.log("[viz-lying-node] ALL OK");
