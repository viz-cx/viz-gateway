// SPIKE: deposit-address peg-out validate-before-burn (offline).
// Guards the irreversible wVIZ burn on BOTH the rolling caps AND the VIZ release
// target existing — a burned-but-unreleasable peg-out is permanent user loss
// (PEG_OUT never refunds). Verifies the pure guard outcomes and the end-to-end
// claim -> guard -> HELD/burn decision against the real store + CircuitBreaker.
//
// Run: node tools/pegout-guard-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { guardPegOut, classifySeenRecovery } = require("../packages/solana-watcher/dist/pegoutGuard");
const { CircuitBreaker, createStore } = require("../packages/common/dist/index.js");

// 1) Pure guard outcomes.
assert.deepStrictEqual(guardPegOut({ ok: true }, true), { burn: true });
console.log("[guard] caps ok + account exists -> burn OK");

let g = guardPegOut({ ok: true }, false);
assert.strictEqual(g.burn, false);
assert.match(g.reason, /does not exist/);
assert.strictEqual(g.pause, undefined, "a missing account holds the row but never pauses the gateway");
console.log("[guard] caps ok + account missing -> HELD, no pause OK");

g = guardPegOut({ ok: false, reason: "OVER_24H" }, true);
assert.strictEqual(g.burn, false);
assert.strictEqual(g.pause, "Solana peg-out 24h cap exceeded", "OVER_24H trips the shared pause");
console.log("[guard] OVER_24H -> HELD + pause OK");

g = guardPegOut({ ok: false, reason: "OVER_PER_TX" }, true);
assert.strictEqual(g.burn, false);
assert.strictEqual(g.pause, undefined, "a per-tx trip holds the row but doesn't halt the gateway");
console.log("[guard] OVER_PER_TX -> HELD, no pause OK");

// caps are checked before existence: a cap trip must not depend on accountExists.
assert.deepStrictEqual(guardPegOut({ ok: false, reason: "OVER_PER_TX" }, false).reason, "OVER_PER_TX");
console.log("[guard] caps evaluated before existence OK");

// 1b) burn-checkpoint recovery (crash between burn and the QUEUED hand-off).
assert.strictEqual(classifySeenRecovery(false, false), "ALERT", "no checkpoint -> manual reconcile");
assert.strictEqual(classifySeenRecovery(false, true), "ALERT", "landed is meaningless without a checkpoint");
assert.strictEqual(classifySeenRecovery(true, true), "REQUEUE", "checkpointed + landed -> hand to dispatcher");
assert.strictEqual(classifySeenRecovery(true, false), "RELEASE", "checkpointed + not landed -> drop claim, retry");
console.log("[recovery] SEEN burn-checkpoint classification OK");

// 2) End-to-end decision against the real store + CircuitBreaker + a fake chain/viz.
(async () => {
  const store = createStore("memory:");
  const caps = { perTxMilliViz: 1_000n, rolling24hMilliViz: 1_500n, manualReviewAboveMilliViz: 10_000n };
  const breaker = new CircuitBreaker(caps, store);

  const existing = new Set(["alice"]); // who exists on VIZ
  const viz = { accountExists: async (name) => existing.has(name) };
  const burned = []; // signatures the (fake) chain actually burned

  // Mirror the scanner's inner step: claim SEEN -> guard -> burn+QUEUED or HELD.
  async function process(id, vizAccount, amount) {
    const first = await store.enqueue({
      id, direction: "PEG_OUT", recipient: vizAccount, amountMilliViz: amount, digest: id, status: "SEEN",
    });
    if (!first) return;
    const cap = await breaker.check(amount);
    const guard = guardPegOut(cap, cap.ok ? await viz.accountExists(vizAccount) : false);
    if (!guard.burn) {
      await store.setStatus(id, "HELD", { lastError: guard.reason });
      if (guard.pause) await store.pause(guard.pause);
      return;
    }
    burned.push(id); // the irreversible burn
    await breaker.record(amount);
    await store.setStatus(id, "QUEUED");
  }

  const statusOf = async (id) => (await store.due(Date.now() + 1, ["HELD", "QUEUED", "SEEN"])).find((r) => r.id === id)?.status
    ?? (await store.stale(Date.now() + 1, 0, ["HELD", "QUEUED", "SEEN"])).find((r) => r.id === id)?.status;

  // a) non-existent account: HELD, NOT burned.
  await process("sig-bob", "bob", 500n);
  assert.ok(!burned.includes("sig-bob"), "non-existent account must not burn");
  assert.strictEqual(await statusOf("sig-bob"), "HELD");
  assert.strictEqual(await store.isPaused(), false, "a missing account doesn't pause the gateway");
  console.log("[e2e] non-existent VIZ account -> HELD, no burn OK");

  // b) valid + within caps: burned + QUEUED + counted in the rolling window.
  await process("sig-alice-1", "alice", 800n);
  assert.ok(burned.includes("sig-alice-1"), "valid peg-out must burn");
  assert.strictEqual(await statusOf("sig-alice-1"), "QUEUED");
  console.log("[e2e] valid peg-out -> burned + QUEUED OK");

  // c) per-tx cap: a single oversized peg-out is HELD, not burned, no pause.
  await process("sig-alice-big", "alice", 2_000n);
  assert.ok(!burned.includes("sig-alice-big"), "over per-tx cap must not burn");
  assert.strictEqual(await statusOf("sig-alice-big"), "HELD");
  assert.strictEqual(await store.isPaused(), false);
  console.log("[e2e] over per-tx cap -> HELD, no burn, no pause OK");

  // d) rolling-24h cap: 800 already recorded; next 800 (<=per-tx) breaches 1,500 -> HELD + PAUSE.
  await process("sig-alice-2", "alice", 800n);
  assert.ok(!burned.includes("sig-alice-2"), "over rolling cap must not burn");
  assert.strictEqual(await statusOf("sig-alice-2"), "HELD");
  assert.strictEqual(await store.isPaused(), true, "OVER_24H pauses the gateway");
  console.log("[e2e] over rolling-24h cap -> HELD + gateway paused OK");

  // e) burn-checkpoint round-trip: a SEEN row carrying the burn signature (txid) is
  // surfaced by stale() so recovery can check whether that signature landed.
  await store.enqueue({ id: "sig-chk", direction: "PEG_OUT", recipient: "alice", amountMilliViz: 1n, digest: "d", status: "SEEN" });
  await store.setStatus("sig-chk", "SEEN", { txid: "burnSig123" }); // checkpoint before QUEUED
  const stuck = (await store.stale(Date.now() + 1, 0, ["SEEN"])).find((r) => r.id === "sig-chk");
  assert.strictEqual(stuck.txid, "burnSig123", "burn signature must survive on the SEEN row");
  assert.strictEqual(classifySeenRecovery(Boolean(stuck.txid), true), "REQUEUE");
  console.log("[e2e] burn checkpoint persisted on SEEN row -> recoverable OK");

  // f) checkAndRecord — the atomic check+record primitive the peg-in/observer watchers now use.
  //    Proves: pure gates (per-tx, manual-review) reject WITHOUT recording; the rolling-24h slot
  //    is reserved atomically only on `ok`; a rejected amount reserves nothing; boundary is exact.
  {
    const { InMemoryGatewayStore } = require("../packages/common/dist/store.js");
    const DAY = 86_400_000;
    const s = new InMemoryGatewayStore();
    const b = new CircuitBreaker({ perTxMilliViz: 1_000n, rolling24hMilliViz: 1_500n, manualReviewAboveMilliViz: 900n }, s);
    const t = 1_000_000;
    assert.deepStrictEqual(await b.checkAndRecord(1_001n, t), { ok: false, reason: "OVER_PER_TX" }, "over per-tx");
    assert.deepStrictEqual(await b.checkAndRecord(950n, t), { ok: false, reason: "NEEDS_MANUAL_REVIEW" }, "manual review");
    assert.strictEqual(await s.capSumMilliViz(t - DAY, t), 0n, "rejected amounts record nothing");
    assert.deepStrictEqual(await b.checkAndRecord(800n, t), { ok: true }, "within caps -> ok");
    assert.strictEqual(await s.capSumMilliViz(t - DAY, t), 800n, "accepted amount recorded exactly once");
    assert.deepStrictEqual(await b.checkAndRecord(800n, t), { ok: false, reason: "OVER_24H" }, "800+800 > 1500 -> OVER_24H");
    assert.strictEqual(await s.capSumMilliViz(t - DAY, t), 800n, "an OVER_24H reject reserves nothing");
    assert.deepStrictEqual(await b.checkAndRecord(700n, t), { ok: true }, "800+700 == 1500 (== cap) fits");
    console.log("[caps] checkAndRecord: pure gates reject w/o recording; 24h reserve atomic + boundary-exact OK");
  }

  console.log("\nRESULT: peg-out validate-before-burn + burn-checkpoint recovery verified.");
  await store.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
