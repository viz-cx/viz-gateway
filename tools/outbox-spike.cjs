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
