// SPIKE: actions orphaned in SEEN are recovered, not silently stuck forever (VG M6).
// A detection-path watcher writes SEEN, then cap-checks and advances to QUEUED. A crash in
// between strands the row in SEEN: the re-scan sees enqueue()->false and continues, and the
// dispatcher only looks at QUEUED/BROADCAST — the mint/release silently never happens. Exercises
// the real recoverStaleSeen against InMemoryGatewayStore + the real CircuitBreaker:
//   1) a stale SEEN row within cap -> QUEUED (requeued), reported for a staff alert.
//   2) a stale SEEN row over the 24h cap -> HELD + gateway paused.
//   3) a FRESH SEEN row (younger than staleMs) is left alone (not swept mid-flight).
//   4) the `match` filter scopes recovery (peg-in only leaves peg-out rows untouched).
//   5) an already-advanced (QUEUED) row is never touched.
//
// Run: node tools/seen-recovery-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { InMemoryGatewayStore, CircuitBreaker, recoverStaleSeen } = require("../packages/common/dist");

const STALE_MS = 5 * 60 * 1000;
const CAPS = {
  perTxMilliViz: 1_000_000n,
  rolling24hMilliViz: 1_500_000n, // two 1M deposits exceed this
  manualReviewAboveMilliViz: 1_000_000n,
};

function pegIn(id, amount, chain = "SOLANA") {
  return { id, direction: "PEG_IN", remoteChain: chain, recipient: "dest", sender: "alice", amountMilliViz: amount, digest: `d-${id}`, status: "SEEN" };
}

// Force a row's updatedAt into the past so store.stale() considers it orphaned.
function ageRow(store, id, ms) {
  const r = store.rows.get(id);
  r.updatedAt = Date.now() - ms;
}

async function requeuesWithinCap() {
  const store = new InMemoryGatewayStore();
  const breaker = new CircuitBreaker(CAPS, store);
  await store.enqueue(pegIn("in-1", 500_000n));
  ageRow(store, "in-1", STALE_MS + 1000);

  const out = await recoverStaleSeen(store, breaker, {
    now: Date.now(), staleMs: STALE_MS, match: (r) => r.direction === "PEG_IN", capPauseReason: "cap",
  });
  assert.deepStrictEqual(out.requeued.map((r) => r.id), ["in-1"], "stale SEEN peg-in requeued");
  assert.strictEqual((await store.get("in-1")).status, "QUEUED", "row advanced to QUEUED");
  assert.strictEqual(out.paused, false, "within cap => no pause");
  console.log("[seen-recovery] stale SEEN within cap -> QUEUED OK");
}

async function overCapHeldAndPaused() {
  const store = new InMemoryGatewayStore();
  const breaker = new CircuitBreaker(CAPS, store);
  // Pre-consume most of the 24h window so the recovered deposit tips it over.
  await breaker.checkAndRecord(1_000_000n);
  await store.enqueue(pegIn("in-2", 1_000_000n));
  ageRow(store, "in-2", STALE_MS + 1000);

  const out = await recoverStaleSeen(store, breaker, {
    now: Date.now(), staleMs: STALE_MS, match: (r) => r.direction === "PEG_IN", capPauseReason: "24h cap exceeded",
  });
  assert.deepStrictEqual(out.held.map((r) => r.id), ["in-2"], "over-cap row HELD, not requeued");
  assert.strictEqual((await store.get("in-2")).status, "HELD", "row moved to HELD");
  assert.strictEqual(out.paused, true, "OVER_24H recovery pauses the gateway");
  assert.ok((await store.pauseReason()).includes("24h cap"), "pause reason surfaces the cap");
  console.log("[seen-recovery] stale SEEN over 24h cap -> HELD + paused OK");
}

async function freshSeenLeftAlone() {
  const store = new InMemoryGatewayStore();
  const breaker = new CircuitBreaker(CAPS, store);
  await store.enqueue(pegIn("in-3", 500_000n)); // updatedAt = now (fresh, mid-flight)

  const out = await recoverStaleSeen(store, breaker, {
    now: Date.now(), staleMs: STALE_MS, match: (r) => r.direction === "PEG_IN", capPauseReason: "cap",
  });
  assert.strictEqual(out.requeued.length, 0, "a fresh in-flight SEEN row is NOT swept");
  assert.strictEqual((await store.get("in-3")).status, "SEEN", "fresh row still SEEN");
  console.log("[seen-recovery] fresh SEEN row left alone (no mid-flight steal) OK");
}

async function matchFilterScopes() {
  const store = new InMemoryGatewayStore();
  const breaker = new CircuitBreaker(CAPS, store);
  await store.enqueue({ id: "out-1", direction: "PEG_OUT", remoteChain: "SOLANA", recipient: "viz-user", amountMilliViz: 500_000n, digest: "do", status: "SEEN" });
  ageRow(store, "out-1", STALE_MS + 1000);

  const out = await recoverStaleSeen(store, breaker, {
    now: Date.now(), staleMs: STALE_MS, match: (r) => r.direction === "PEG_IN", capPauseReason: "cap",
  });
  assert.strictEqual(out.requeued.length + out.held.length, 0, "peg-in match leaves peg-out rows untouched");
  assert.strictEqual((await store.get("out-1")).status, "SEEN", "unmatched row stays SEEN");
  console.log("[seen-recovery] match filter scopes recovery (peg-out untouched) OK");
}

async function queuedRowUntouched() {
  const store = new InMemoryGatewayStore();
  const breaker = new CircuitBreaker(CAPS, store);
  await store.enqueue(pegIn("in-4", 500_000n));
  await store.setStatus("in-4", "QUEUED");
  ageRow(store, "in-4", STALE_MS + 1000);

  const out = await recoverStaleSeen(store, breaker, {
    now: Date.now(), staleMs: STALE_MS, match: (r) => r.direction === "PEG_IN", capPauseReason: "cap",
  });
  assert.strictEqual(out.requeued.length, 0, "already-QUEUED row is not re-processed (only SEEN is swept)");
  console.log("[seen-recovery] non-SEEN (QUEUED) row untouched OK");
}

(async () => {
  await requeuesWithinCap();
  await overCapHeldAndPaused();
  await freshSeenLeftAlone();
  await matchFilterScopes();
  await queuedRowUntouched();
  console.log("[seen-recovery] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
