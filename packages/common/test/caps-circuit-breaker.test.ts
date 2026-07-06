import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, type CapPolicy } from "../src/caps";
import { InMemoryGatewayStore } from "../src/store";

// Money-safety: the CircuitBreaker is the blast-radius limiter for every mint/release.
// These assert the invariants directly (the spikes only exercise it as a dependency):
//  - gate ORDER (issue #37): per-tx -> 24h -> manual-review, so a rolling-window breach
//    reports OVER_24H (the cross-process pause) rather than silently HOLDing one tx;
//  - checkAndRecord is the atomic reserve primitive: a rejection reserves nothing, an
//    accept (incl. the manual-review band) consumes a 24h slot.

const DAY_MS = 24 * 60 * 60 * 1000;

// perTx 100, rolling 1000, manual-review above 60. Amounts are integer milli-VIZ.
const policy: CapPolicy = {
  perTxMilliViz: 100n,
  rolling24hMilliViz: 1000n,
  manualReviewAboveMilliViz: 60n,
};

const T0 = 1_000_000_000_000; // fixed clock so the rolling window is deterministic

test("per-tx breach is rejected and reserves nothing", async () => {
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker(policy, store);
  const d = await cb.checkAndRecord(101n, T0);
  assert.deepEqual(d, { ok: false, reason: "OVER_PER_TX" });
  assert.equal(await store.capSumMilliViz(T0 - DAY_MS, T0), 0n, "a rejected tx must not consume a 24h slot");
});

test("an accepted tx is admitted and consumes its 24h slot", async () => {
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker(policy, store);
  const d = await cb.checkAndRecord(50n, T0); // <= per-tx, <= manual-review, fits window
  assert.deepEqual(d, { ok: true });
  assert.equal(await store.capSumMilliViz(T0 - DAY_MS, T0), 50n);
});

test("manual-review-band tx is HELD but still reserves its slot (conservative direction)", async () => {
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker(policy, store);
  const d = await cb.checkAndRecord(70n, T0); // > manual-review 60, <= per-tx, fits window
  assert.deepEqual(d, { ok: false, reason: "NEEDS_MANUAL_REVIEW" });
  assert.equal(await store.capSumMilliViz(T0 - DAY_MS, T0), 70n, "manual-review hold reserves the slot (docstring)");
});

test("issue #37: a 24h breach in the manual-review band reports OVER_24H, not NEEDS_MANUAL_REVIEW", async () => {
  // A tight window (80) so the second tx both breaches 24h AND sits in the manual-review band (>60).
  const tight: CapPolicy = { perTxMilliViz: 100n, rolling24hMilliViz: 80n, manualReviewAboveMilliViz: 60n };
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker(tight, store);

  assert.deepEqual(await cb.checkAndRecord(50n, T0), { ok: true });
  const d = await cb.checkAndRecord(70n, T0); // 50+70=120 > 80 window; 70 > 60 manual band
  assert.deepEqual(d, { ok: false, reason: "OVER_24H" }, "24h gate must precede manual-review so the pause fires");
  assert.equal(await store.capSumMilliViz(T0 - DAY_MS, T0), 50n, "the OVER_24H rejection reserved nothing");
});

test("rolling window slides: a slot older than 24h no longer counts", async () => {
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker({ perTxMilliViz: 100n, rolling24hMilliViz: 150n, manualReviewAboveMilliViz: 100n }, store);

  assert.deepEqual(await cb.checkAndRecord(100n, T0), { ok: true });
  // Same-window: 100 + 60 > 150 -> blocked.
  assert.deepEqual(await cb.check(60n, T0 + 1), { ok: false, reason: "OVER_24H" });
  // A day-and-a-bit later the T0 slot has aged out of the window -> admitted again.
  assert.deepEqual(await cb.check(100n, T0 + DAY_MS + 1), { ok: true });
});

test("checkAndRecord is atomic across concurrent callers: only what fits is reserved", async () => {
  // Cap 100, two racing 60s. A non-atomic check()+record() pair would let both pass; the atomic
  // reserve must admit exactly one (single-threaded JS: the InMemory store models the sqlite txn).
  const store = new InMemoryGatewayStore();
  const cb = new CircuitBreaker({ perTxMilliViz: 100n, rolling24hMilliViz: 100n, manualReviewAboveMilliViz: 100n }, store);
  const [a, b] = await Promise.all([cb.checkAndRecord(60n, T0), cb.checkAndRecord(60n, T0)]);
  const admitted = [a, b].filter((d) => d.ok).length;
  assert.equal(admitted, 1, "exactly one of two racing over-cap reservations may succeed");
  assert.equal(await store.capSumMilliViz(T0 - DAY_MS, T0), 60n, "only the admitted tx consumed a slot");
});
