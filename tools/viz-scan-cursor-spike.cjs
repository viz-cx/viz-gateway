// SPIKE: viz-watcher peg-in detection is gap-free across downtime + bursts (VG-03).
// Two properties, both offline against the real production helpers:
//   1) the durable cursor resumes after a restart (never cold-starts back at head);
//   2) a backlog larger than MAX_BLOCKS_PER_SCAN is caught over successive ticks,
//      advancing the cursor only to what was actually scanned — no block skipped.
//
// Run: node tools/viz-scan-cursor-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { InMemoryGatewayStore } = require("../packages/common/dist/store");
const { MAX_BLOCKS_PER_SCAN, nextScanWindow } = require("../packages/viz-watcher/dist/vizChain");
const CURSOR = "cursor:viz-watcher";

async function durableCursorResumes() {
  const store = new InMemoryGatewayStore();
  assert.strictEqual(await store.getCursor(CURSOR), 0, "unset cursor is 0 (cold start)");
  await store.setCursor(CURSOR, 5000);
  // "restart": a new watcher reads the same shared store and must NOT cold-start.
  assert.strictEqual(await store.getCursor(CURSOR), 5000, "cursor resumes from persisted value");
  console.log("[viz-cursor] resume-from-persisted OK");

  // monotonic: a stale/racing writer cannot rewind the cursor.
  await store.setCursor(CURSOR, 4000);
  assert.strictEqual(await store.getCursor(CURSOR), 5000, "backward write ignored (monotonic)");
  await store.setCursor(CURSOR, 6000);
  assert.strictEqual(await store.getCursor(CURSOR), 6000, "forward write advances");
  console.log("[viz-cursor] monotonic advance OK");
}

async function backlogDrainsGapFree() {
  const store = new InMemoryGatewayStore();
  // Cold-start decision: first-ever run pins the cursor at the safe head and persists.
  let cursor = await store.getCursor(CURSOR);
  assert.strictEqual(cursor, 0);
  const coldHead = 1000;
  cursor = coldHead;
  await store.setCursor(CURSOR, cursor);

  // Now the chain jumps far ahead (a long downtime / burst): a 512-block backlog,
  // more than 2x the per-scan cap. Drive the exact production window math tick by
  // tick and record every [start, scannedTo] range the watcher would scan.
  const safeHead = coldHead + 512;
  const scanned = []; // union of scanned block ranges
  let ticks = 0;
  let caughtUp = false;
  while (!caughtUp) {
    assert.ok(++ticks < 100, "must converge, not loop forever");
    const w = nextScanWindow(cursor, safeHead);
    assert.ok(w.scannedTo <= safeHead, "scannedTo never exceeds the real safe head");
    assert.ok(w.scannedTo - cursor <= MAX_BLOCKS_PER_SCAN, "advance capped at MAX_BLOCKS_PER_SCAN");
    scanned.push([cursor + 1, w.scannedTo]); // irreversibleDepositsSince scans (cursor, scannedTo]
    cursor = w.scannedTo;
    await store.setCursor(CURSOR, cursor); // persisted after each tick
    caughtUp = w.caughtUp;
  }

  // The first tick must NOT jump straight to head (that was the bug).
  assert.strictEqual(scanned[0][1], coldHead + MAX_BLOCKS_PER_SCAN, "first tick advances by the cap, not to head");
  assert.ok(ticks >= 3, "a 512-block backlog needs multiple ticks");
  assert.strictEqual(cursor, safeHead, "cursor ends exactly at the safe head");
  assert.strictEqual(await store.getCursor(CURSOR), safeHead, "persisted cursor matches");

  // Coverage: the scanned ranges must tile (coldHead, safeHead] with no gap/overlap.
  let expectNext = coldHead + 1;
  for (const [start, end] of scanned) {
    assert.strictEqual(start, expectNext, `no gap/overlap at block ${start}`);
    expectNext = end + 1;
  }
  assert.strictEqual(expectNext - 1, safeHead, "coverage reaches the safe head exactly");
  console.log(`[viz-cursor] 512-block backlog drained gap-free over ${ticks} ticks OK`);
}

(async () => {
  await durableCursorResumes();
  await backlogDrainsGapFree();
  console.log("viz-scan-cursor-spike: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
