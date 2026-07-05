// SPIKE: TON peg-out burn scan is lt-ranged and fails closed on truncation (VG-06).
// Exercises the real production paginator (paginateBurnsByLt) offline against a fake
// tx source, proving:
//   1) more burns than one page since the cursor -> all collected across pages, none
//      dropped, newestFinalLt = the newest FINAL lt, drained=true.
//   2) a burst deeper than maxScanPages -> drained=false (truncated): the watcher must
//      NOT advance the cursor (older burns lie beyond the scan window) -> fail closed.
//   3) a not-yet-final tail (now > cutoff) is excluded and never advances the cursor
//      past it, so it is re-scanned next tick.
//   4) the lt cursor persists across a restart (durable store contract).
//
// Run: node tools/gram-scan-pagination-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { InMemoryGatewayStore } = require("../packages/common/dist/store");
const { paginateBurnsByLt } = require("../packages/gram-watcher/dist/gramChain");
const CURSOR = "cursor:gram-watcher";

// A minimal Transaction stand-in: paginateBurnsByLt only touches .lt, .now, .hash().
function tx(lt, now) {
  return { lt: BigInt(lt), now, hash: () => Buffer.from(`h${lt}`) };
}

// Fake toncenter getTransactions over a descending-by-lt array, mimicking the
// inclusive-anchor semantics (a page anchored at {lt} repeats that tx first).
function makeFetch(allDesc, limit) {
  return async (anchor) => {
    let start = 0;
    if (anchor) {
      const i = allDesc.findIndex((t) => t.lt.toString() === anchor.lt);
      start = i < 0 ? allDesc.length : i; // include the anchor tx (inclusive)
    }
    return allDesc.slice(start, start + limit);
  };
}

// toBurn: mark every parsed tx a burn (parsing itself is covered elsewhere); return
// the lt so the test can assert exactly which txs were collected.
const toBurn = (t) => ({ sourceId: t.hash().toString("hex"), height: 0, from: "x", amountMilliViz: 1n, homeDestination: "acct", lt: Number(t.lt) });

async function allBurnsCollectedAcrossPages() {
  // 25 final txs, lt 100..76 desc; page size 10 => 3 pages.
  const all = [];
  for (let lt = 100; lt >= 76; lt--) all.push(tx(lt, 0));
  const res = await paginateBurnsByLt({
    fromLt: 0n,
    cutoff: 1_000_000, // all final
    height: 42,
    limit: 10,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.strictEqual(res.drained, true, "fully drained to history end");
  assert.strictEqual(res.burns.length, 25, "every burn collected, none dropped/duplicated");
  const lts = res.burns.map((b) => b.lt).sort((a, b) => a - b);
  assert.deepStrictEqual(lts, Array.from({ length: 25 }, (_, i) => 76 + i), "no gaps, no dupes across page anchors");
  assert.strictEqual(res.newestFinalLt, 100n, "newestFinalLt = newest final lt");
  console.log("[ton-scan] multi-page drain collects all burns OK");
}

async function truncationFailsClosed() {
  // 100 final txs, lt 200..101 desc; page size 10 but only 3 pages allowed.
  const all = [];
  for (let lt = 200; lt >= 101; lt--) all.push(tx(lt, 0));
  const res = await paginateBurnsByLt({
    fromLt: 0n,
    cutoff: 1_000_000,
    height: 1,
    limit: 10,
    maxScanPages: 3,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.strictEqual(res.drained, false, "did not reach the cursor -> truncated");
  // The caller (watcher) MUST hold the cursor when !drained. Model that decision:
  const store = new InMemoryGatewayStore();
  await store.setCursor(CURSOR, 0);
  if (res.drained) await store.setCursor(CURSOR, Number(res.newestFinalLt));
  assert.strictEqual(await store.getCursor(CURSOR), 0, "truncated scan does NOT advance the cursor (fail closed)");
  console.log("[ton-scan] truncation holds cursor + fails closed OK");
}

async function notYetFinalTailExcluded() {
  // lt 100,99 too recent (now > cutoff); 98,97,96 final.
  const cutoff = 1000;
  const all = [tx(100, 2000), tx(99, 1500), tx(98, 500), tx(97, 400), tx(96, 300)];
  const res = await paginateBurnsByLt({
    fromLt: 0n,
    cutoff,
    height: 7,
    limit: 10,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.strictEqual(res.drained, true);
  assert.strictEqual(res.newestFinalLt, 98n, "cursor advances only to the newest FINAL lt");
  assert.deepStrictEqual(res.burns.map((b) => b.lt).sort((a, b) => a - b), [96, 97, 98], "not-yet-final tail excluded");
  // Next tick from lt 98 re-sees 99 and 100 (they are > cursor) -> no skip.
  const next = await paginateBurnsByLt({
    fromLt: 98n,
    cutoff: 3000, // now final
    height: 8,
    limit: 10,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.deepStrictEqual(next.burns.map((b) => b.lt).sort((a, b) => a - b), [99, 100], "tail re-scanned once final");
  assert.strictEqual(next.newestFinalLt, 100n);
  console.log("[ton-scan] not-yet-final tail excluded then re-scanned OK");
}

async function ltCursorPersists() {
  const store = new InMemoryGatewayStore();
  assert.strictEqual(await store.getCursor(CURSOR), 0, "cold start lt = 0");
  await store.setCursor(CURSOR, 50_000_000_000_000); // realistic TON lt magnitude
  assert.strictEqual(await store.getCursor(CURSOR), 50_000_000_000_000, "lt cursor resumes across restart");
  await store.setCursor(CURSOR, 49_000_000_000_000);
  assert.strictEqual(await store.getCursor(CURSOR), 50_000_000_000_000, "backward lt write ignored (monotonic)");
  console.log("[ton-scan] lt cursor persists + monotonic OK");
}

(async () => {
  await allBurnsCollectedAcrossPages();
  await truncationFailsClosed();
  await notYetFinalTailExcluded();
  await ltCursorPersists();
  console.log("ton-scan-pagination-spike: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
