// SPIKE: durable outbox + shared cap window (offline, sqlite).
// Verifies the action_outbox state machine and the cross-restart cap window:
//   - enqueue is an atomic first-claim (second enqueue of same id returns false),
//   - HELD actions are persisted, not dropped,
//   - status transitions + backoff (nextAttemptAt) drive the `due` work list,
//   - unsweptFeesMilliViz = minted PEG_IN fees − confirmed FEE_SWEEP amounts,
//   - the 24h cap window survives a store reopen (the old in-memory window did not).
//
// Run: node tools/outbox-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createStore, SqliteGatewayStore } = require("../packages/common/dist/store");

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "viz-outbox-"));
  const dbPath = join(dir, "gateway.sqlite");
  let store = new SqliteGatewayStore(dbPath);

  // 1) enqueue is an atomic first-claim.
  const first = await store.enqueue({
    id: "trx1:0",
    direction: "PEG_IN",
    remoteChain: "SOLANA",
    recipient: "alice",
    amountMilliViz: 10_000_000n,
    feeMilliViz: 20_000n,
    digest: "d1",
    status: "SEEN",
  });
  assert.strictEqual(first, true, "first enqueue claims");
  const again = await store.enqueue({
    id: "trx1:0",
    direction: "PEG_IN",
    recipient: "alice",
    amountMilliViz: 10_000_000n,
    digest: "d1",
  });
  assert.strictEqual(again, false, "second enqueue of same id is rejected (idempotent)");
  console.log("[outbox] enqueue atomic first-claim OK");

  // 2) HELD is persisted, not lost.
  await store.enqueue({ id: "held1", direction: "PEG_OUT", recipient: "bob", amountMilliViz: 1n, digest: "d2" });
  await store.setStatus("held1", "HELD", { lastError: "OVER_PER_TX" });
  const held = await store.get("held1");
  assert.strictEqual(held.status, "HELD");
  assert.strictEqual(held.lastError, "OVER_PER_TX");
  console.log("[outbox] HELD persisted (not dropped) OK");

  // 3) status + backoff drive `due`.
  await store.setStatus("trx1:0", "QUEUED");
  let due = await store.due(Date.now(), ["QUEUED", "FAILED"]);
  assert.ok(due.some((r) => r.id === "trx1:0"), "QUEUED row is due");
  // Push next attempt into the future -> no longer due now.
  await store.setStatus("trx1:0", "FAILED", { attempts: 1, lastError: "rpc down", nextAttemptAt: Date.now() + 60_000 });
  due = await store.due(Date.now(), ["QUEUED", "FAILED"]);
  assert.ok(!due.some((r) => r.id === "trx1:0"), "backoff: future nextAttemptAt is not due");
  due = await store.due(Date.now() + 61_000, ["QUEUED", "FAILED"]);
  assert.ok(due.some((r) => r.id === "trx1:0"), "becomes due after backoff window");
  console.log("[outbox] status transitions + backoff `due` OK");

  // 4) unswept fees = minted PEG_IN fees − confirmed FEE_SWEEP amounts.
  await store.setStatus("trx1:0", "CONFIRMED"); // PEG_IN minted (fee 20_000 now surplus)
  let unswept = await store.unsweptFeesMilliViz();
  assert.strictEqual(unswept, 20_000n, "fee counts as unswept until FEE_SWEEP confirms");
  await store.enqueue({ id: "sweep1", direction: "FEE_SWEEP", recipient: "fees.gate", amountMilliViz: 20_000n, digest: "d3" });
  await store.setStatus("sweep1", "CONFIRMED");
  unswept = await store.unsweptFeesMilliViz();
  assert.strictEqual(unswept, 0n, "after sweep confirms, unswept fees are zero");
  console.log("[outbox] unswept-fee accounting OK");

  // 4b) production flow: the watcher enqueues a PEG_IN with NO fee (it doesn't yet
  //     know the net split); the dispatcher pins the real fee via the CONFIRMED
  //     patch. Before this fix the fee stayed 0 forever and unswept was always 0.
  await store.enqueue({ id: "trx2:0", direction: "PEG_IN", remoteChain: "TON", recipient: "carol", amountMilliViz: 5_000_000n, digest: "d4", status: "QUEUED" });
  assert.strictEqual((await store.get("trx2:0")).feeMilliViz, 0n, "watcher enqueues fee 0");
  await store.setStatus("trx2:0", "CONFIRMED", { txid: "t2", feeMilliViz: 15_000n });
  assert.strictEqual((await store.get("trx2:0")).feeMilliViz, 15_000n, "fee pinned at delivery time");
  assert.strictEqual(await store.unsweptFeesMilliViz(), 15_000n, "pinned fee now counts as unswept");
  // delete() releases an unfulfilled claim (used by the peg-out claim-before-burn path).
  await store.delete("trx2:0");
  assert.strictEqual(await store.get("trx2:0"), undefined, "delete removes the row");
  assert.strictEqual(await store.unsweptFeesMilliViz(), 0n);
  console.log("[outbox] fee pinned at delivery + delete OK");

  // 4b') setFee pins the withheld fee WITHOUT a status change (the coordinator calls
  //      this before broadcast, so a lost response / recovery can still spawn the
  //      FEE_SWEEP instead of stranding the fee as surplus — PR#11 follow-up #3).
  await store.enqueue({ id: "trx3:0", direction: "PEG_IN", remoteChain: "TON", recipient: "erin", amountMilliViz: 8_000_000n, digest: "d4b", status: "BROADCAST" });
  await store.setFee("trx3:0", 24_000n);
  const pinned = await store.get("trx3:0");
  assert.strictEqual(pinned.feeMilliViz, 24_000n, "setFee pins the fee");
  assert.strictEqual(pinned.status, "BROADCAST", "setFee does not change status");
  assert.strictEqual(await store.unsweptFeesMilliViz(), 24_000n, "pinned fee counts as unswept (BROADCAST is minted)");
  await store.delete("trx3:0");
  console.log("[outbox] setFee pins fee without status change OK");

  // 4c) stale() surfaces orphaned SIGNING rows so the dispatcher can requeue them
  //     (a crash between marking SIGNING and recording the transition).
  await store.enqueue({ id: "sig1", direction: "PEG_OUT", recipient: "dave", amountMilliViz: 1n, digest: "d5", status: "QUEUED" });
  await store.setStatus("sig1", "SIGNING");
  const orphaned = await store.stale(Date.now() + 10_000, 5_000, ["SIGNING"]);
  assert.ok(orphaned.some((r) => r.id === "sig1"), "a long-running SIGNING row is surfaced by stale()");
  console.log("[outbox] stale() surfaces orphaned SIGNING OK");

  // 5) cap window survives a reopen.
  const now = Date.now();
  await store.recordCap(500_000n, now);
  await store.recordCap(300_000n, now);
  assert.strictEqual(await store.capSumMilliViz(now - 1000, now + 1000), 800_000n);
  await store.close();
  store = new SqliteGatewayStore(dbPath); // simulate a restart
  assert.strictEqual(
    await store.capSumMilliViz(now - 1000, now + 1000),
    800_000n,
    "cap window persists across restart (in-memory window would reset to 0)",
  );
  // expiry prunes old entries
  assert.strictEqual(await store.capSumMilliViz(now + 1000, now + 2000), 0n, "entries outside the window are excluded");
  await store.close();
  console.log("[outbox] shared cap window survives restart OK");

  // 6) overflow-safe sums (PR#11 follow-up #4): a running total past 2^63 makes
  //    SQLite SUM(CAST(... AS INTEGER)) spill into a lossy REAL, and BigInt("…e+18")
  //    throws. Summing in JS with BigInt has no such ceiling. Two milli-VIZ values
  //    whose sum exceeds 2^63 (=9.22e18) must add EXACTLY, not crash.
  store = new SqliteGatewayStore(dbPath); // reopen (section 5 closed it)
  const BIG = 9_000_000_000_000_000_000n; // < 2^63 individually, > 2^63 summed
  await store.enqueue({ id: "big1", direction: "PEG_IN", remoteChain: "TON", recipient: "z1", amountMilliViz: BIG, feeMilliViz: BIG, digest: "b1", status: "CONFIRMED" });
  await store.enqueue({ id: "big2", direction: "PEG_IN", remoteChain: "TON", recipient: "z2", amountMilliViz: BIG, feeMilliViz: BIG, digest: "b2", status: "CONFIRMED" });
  assert.strictEqual(await store.unsweptFeesMilliViz(), BIG * 2n, "unswept fees sum exactly past 2^63 (no REAL overflow)");
  await store.delete("big1");
  await store.delete("big2");
  const capNow = Date.now();
  await store.recordCap(BIG, capNow);
  await store.recordCap(BIG, capNow);
  assert.strictEqual(await store.capSumMilliViz(capNow - 1000, capNow + 1000), BIG * 2n, "cap window sums exactly past 2^63");
  await store.close();
  console.log("[outbox] overflow-safe BigInt sums OK");

  // memory: store also satisfies the interface.
  const mem = createStore("memory:");
  assert.strictEqual(await mem.enqueue({ id: "x", direction: "PEG_OUT", recipient: "r", amountMilliViz: 1n, digest: "d" }), true);
  assert.strictEqual(await mem.enqueue({ id: "x", direction: "PEG_OUT", recipient: "r", amountMilliViz: 1n, digest: "d" }), false);
  console.log("[outbox] in-memory store parity OK");

  console.log("\nRESULT: durable outbox state machine + shared cap window verified.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
