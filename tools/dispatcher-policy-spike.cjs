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

// 1) broadcast success -> CONFIRMED, and the withheld fee is pinned onto the row
//    (so unsweptFeesMilliViz() can later see it — the watcher enqueued fee 0).
let t = planTransition(base, { broadcast: true, txid: "abc", feeMilliViz: 20_000n }, base.createdAt + 5_000, opts);
assert.strictEqual(t.status, "CONFIRMED");
assert.strictEqual(t.patch.txid, "abc");
assert.strictEqual(t.patch.feeMilliViz, 20_000n);
console.log("[dispatcher] success -> CONFIRMED + fee pinned OK");

// 2) failure within window -> QUEUED, attempts++, backoff in the future.
const now2 = base.createdAt + 30_000;
t = planTransition(base, { broadcast: false, error: "rpc 429" }, now2, opts);
assert.strictEqual(t.status, "QUEUED");
assert.strictEqual(t.patch.attempts, 1);
assert.strictEqual(t.patch.nextAttemptAt, now2 + 10_000);
assert.match(t.patch.lastError, /429/);
console.log("[dispatcher] failure within window -> QUEUED + backoff OK");

// 3) failure past the 3-min window -> REFUNDING (PEG_IN only).
const now3 = base.createdAt + 180_000;
t = planTransition(base, { broadcast: false, error: "still down" }, now3, opts);
assert.strictEqual(t.status, "REFUNDING");
assert.match(t.patch.lastError, /window exhausted/);
console.log("[dispatcher] PEG_IN failure past window -> REFUNDING OK");

// 3b) a PEG_OUT / FEE_SWEEP / REFUND has nothing to refund — the gateway already
//     owes the release — so past the window it keeps retrying (QUEUED), never
//     dead-ends into REFUNDING.
for (const direction of ["PEG_OUT", "FEE_SWEEP", "REFUND"]) {
  const r = planTransition({ ...base, direction }, { broadcast: false, error: "still down" }, now3, opts);
  assert.strictEqual(r.status, "QUEUED", `${direction} past window should keep retrying`);
  assert.strictEqual(r.patch.nextAttemptAt, now3 + 10_000);
}
console.log("[dispatcher] PEG_OUT/FEE_SWEEP/REFUND past window -> keep retrying (QUEUED) OK");

// 4) child spawns: CONFIRMED PEG_IN -> FEE_SWEEP to fees.gate (amount = base, VG-04).
//    The sweep amount is the independently-derived `base` (sweepAmountMilliViz), NOT the
//    coordinator-pinned withheld fee (base + activation) — any surcharge stays as surplus.
const sender = { ...base, sender: "alice" };
let kids = planChildren(sender, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 20_000n , refundFeeMilliViz: 0n});
assert.strictEqual(kids.length, 1);
assert.strictEqual(kids[0].direction, "FEE_SWEEP");
assert.strictEqual(kids[0].recipient, "fees.gate");
assert.strictEqual(kids[0].amountMilliViz, 20_000n);
assert.strictEqual(kids[0].id, "trx1:0:fee");
console.log("[dispatcher] CONFIRMED PEG_IN -> FEE_SWEEP(fees.gate, base) OK");

// 4b) a zero sweep amount (unknown/absent) spawns no FEE_SWEEP — never a zero-value release.
assert.strictEqual(planChildren(sender, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n , refundFeeMilliViz: 0n}).length, 0);
console.log("[dispatcher] CONFIRMED PEG_IN with zero sweep -> no FEE_SWEEP OK");

// 5) REFUNDING PEG_IN -> REFUND gross to the original sender.
kids = planChildren(sender, "REFUNDING", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n , refundFeeMilliViz: 0n});
assert.strictEqual(kids.length, 1);
assert.strictEqual(kids[0].direction, "REFUND");
assert.strictEqual(kids[0].recipient, "alice");
assert.strictEqual(kids[0].amountMilliViz, base.amountMilliViz); // gross
console.log("[dispatcher] REFUNDING PEG_IN -> REFUND(sender, gross) OK");

// 6) no children for a plain PEG_OUT.
assert.strictEqual(planChildren({ ...base, direction: "PEG_OUT" }, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 20_000n , refundFeeMilliViz: 0n}).length, 0);
console.log("[dispatcher] PEG_OUT spawns no children OK");

console.log("\nRESULT: dispatcher P3 retry/backoff/refund + FEE_SWEEP/REFUND spawn verified.");
