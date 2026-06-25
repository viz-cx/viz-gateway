// SPIKE: dispatcher retry/backoff transition policy (offline, pure).
// Verifies P3: broadcast -> CONFIRMED; failure within window -> QUEUED with
// backoff; failure past the 3-min window -> REFUNDING.
//
// Run: node tools/dispatcher-policy-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { planTransition, planChildren } = require("../packages/dispatcher/dist/policy");

const base = {
  id: "trx1:0",
  direction: "PEG_IN",
  recipient: "alice",
  amountMilliViz: 10_000_000n,
  feeMilliViz: 20_000n,
  digest: "d1",
  status: "QUEUED",
  attempts: 0,
  lastError: null,
  txid: null,
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  nextAttemptAt: 0,
};
const opts = { retryIntervalMs: 10_000, windowMs: 180_000 };

// 1) broadcast success -> CONFIRMED.
let t = planTransition(base, { broadcast: true, txid: "abc" }, base.createdAt + 5_000, opts);
assert.strictEqual(t.status, "CONFIRMED");
assert.strictEqual(t.patch.txid, "abc");
console.log("[dispatcher] success -> CONFIRMED OK");

// 2) failure within window -> QUEUED, attempts++, backoff in the future.
const now2 = base.createdAt + 30_000;
t = planTransition(base, { broadcast: false, error: "rpc 429" }, now2, opts);
assert.strictEqual(t.status, "QUEUED");
assert.strictEqual(t.patch.attempts, 1);
assert.strictEqual(t.patch.nextAttemptAt, now2 + 10_000);
assert.match(t.patch.lastError, /429/);
console.log("[dispatcher] failure within window -> QUEUED + backoff OK");

// 3) failure past the 3-min window -> REFUNDING.
const now3 = base.createdAt + 180_000;
t = planTransition(base, { broadcast: false, error: "still down" }, now3, opts);
assert.strictEqual(t.status, "REFUNDING");
assert.match(t.patch.lastError, /window exhausted/);
console.log("[dispatcher] failure past window -> REFUNDING OK");

// 4) child spawns: CONFIRMED PEG_IN -> FEE_SWEEP to fees.gate (amount = fee).
const sender = { ...base, sender: "alice" };
let kids = planChildren(sender, "CONFIRMED", { feesGateAccount: "fees.gate", feeMilliViz: 20_000n });
assert.strictEqual(kids.length, 1);
assert.strictEqual(kids[0].direction, "FEE_SWEEP");
assert.strictEqual(kids[0].recipient, "fees.gate");
assert.strictEqual(kids[0].amountMilliViz, 20_000n);
assert.strictEqual(kids[0].id, "trx1:0:fee");
console.log("[dispatcher] CONFIRMED PEG_IN -> FEE_SWEEP(fees.gate, fee) OK");

// 5) REFUNDING PEG_IN -> REFUND gross to the original sender.
kids = planChildren(sender, "REFUNDING", { feesGateAccount: "fees.gate", feeMilliViz: 0n });
assert.strictEqual(kids.length, 1);
assert.strictEqual(kids[0].direction, "REFUND");
assert.strictEqual(kids[0].recipient, "alice");
assert.strictEqual(kids[0].amountMilliViz, base.amountMilliViz); // gross
console.log("[dispatcher] REFUNDING PEG_IN -> REFUND(sender, gross) OK");

// 6) no children for a plain PEG_OUT.
assert.strictEqual(planChildren({ ...base, direction: "PEG_OUT" }, "CONFIRMED", { feesGateAccount: "fees.gate", feeMilliViz: 0n }).length, 0);
console.log("[dispatcher] PEG_OUT spawns no children OK");

console.log("\nRESULT: dispatcher P3 retry/backoff/refund + FEE_SWEEP/REFUND spawn verified.");
