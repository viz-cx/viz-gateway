// SPIKE: enqueue fails closed on an idempotency-key COLLISION (VG M5).
// The outbox dedups on `id` alone (PEG_IN id=trxId:opIndex, PEG_OUT id=sourceId). Two DISTINCT
// events sharing an id (a cross-chain sourceId clash, or peg-in vs peg-out) used to be silently
// dropped by INSERT OR IGNORE (changes=0) — different digests, nobody compared them, the second
// event's output vanished (loss/griefing). Now a same-id/DIFFERENT-digest enqueue pauses the
// gateway; a same-id/SAME-digest enqueue is still a silent idempotent replay.
//
// Runs against BOTH store impls (in-memory + real sqlite), since both were patched.
//   1) fresh id -> inserted (true), not paused.
//   2) same id, SAME digest -> false (silent replay), NOT paused.
//   3) same id, DIFFERENT digest -> false AND paused with a collision reason.
//   4) a different id after a collision still enqueues (only the colliding pair is anomalous).
//
// Run: node tools/idempotency-collision-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { InMemoryGatewayStore, SqliteGatewayStore } = require("../packages/common/dist/store");

function row(id, digest, extra = {}) {
  return {
    id,
    direction: "PEG_OUT",
    remoteChain: "GRAM",
    recipient: "viz-user",
    sender: undefined,
    amountMilliViz: 1000n,
    digest,
    status: "SEEN",
    ...extra,
  };
}

async function exercise(label, store) {
  // 1) fresh id inserts.
  assert.strictEqual(await store.enqueue(row("evt-1", "digestA")), true, `${label}: fresh id inserted`);
  assert.strictEqual(await store.isPaused(), false, `${label}: no pause on a clean insert`);

  // 2) same id + same digest = idempotent replay: false, still not paused.
  assert.strictEqual(await store.enqueue(row("evt-1", "digestA")), false, `${label}: same-digest replay ignored`);
  assert.strictEqual(await store.isPaused(), false, `${label}: replay does NOT pause`);

  // 3) same id + DIFFERENT digest = collision of two distinct events: false AND paused.
  assert.strictEqual(await store.enqueue(row("evt-1", "digestB")), false, `${label}: collision not inserted`);
  assert.strictEqual(await store.isPaused(), true, `${label}: collision fails closed (paused)`);
  const reason = await store.pauseReason();
  assert.ok(reason && /collision/i.test(reason) && reason.includes("evt-1"), `${label}: pause reason names the collision: "${reason}"`);

  // 4) an unrelated id still enqueues (the pause is a flag; enqueue itself doesn't gate on it).
  assert.strictEqual(await store.enqueue(row("evt-2", "digestC")), true, `${label}: distinct id still enqueues`);

  console.log(`[idempotency-collision] ${label}: replay silent, cross-event collision fails closed OK`);
}

(async () => {
  await exercise("in-memory", new InMemoryGatewayStore());

  const dir = mkdtempSync(join(tmpdir(), "viz-collision-"));
  const store = new SqliteGatewayStore(join(dir, "gateway.sqlite"));
  await exercise("sqlite", store);
  await store.close();

  console.log("[idempotency-collision] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
