// SPIKE: Solana peg-out burn scan is slot-ranged and fails closed on truncation (VG H4).
// Exercises the real production paginator (paginateBurnsBySlot) offline against a fake
// signature source, proving the same guarantees the TON watcher already had:
//   1) more burns than one page since the cursor -> all collected across pages, none
//      dropped/duplicated, newestFinalSlot = the newest FINAL slot, drained=true.
//   2) a burst deeper than maxScanPages -> drained=false (truncated): the watcher must
//      NOT advance the cursor (older burns lie beyond the scan window) -> fail closed.
//   3) a not-yet-final tail (slot > safeSlot) is excluded and never advances the cursor
//      past it, so it is re-scanned next tick.
//   4) failed (err) signatures are skipped as burns but still walked for pagination.
//   5) reaching the cursor (slot <= fromSlot) drains and stops early.
//
// Run: node tools/solana-scan-pagination-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { paginateBurnsBySlot } = require("../packages/solana-watcher/dist/solanaChain");

function sig(slot, err = null) {
  return { signature: `s${slot}`, slot, err };
}

// Fake getSignaturesForAddress over a descending-by-slot array. Solana's `before` anchor
// is EXCLUSIVE (returns signatures strictly OLDER than the given one), unlike TON's
// inclusive {lt,hash} anchor — the fake mirrors that.
function makeFetch(allDesc, limit) {
  return async (before) => {
    let start = 0;
    if (before) {
      const i = allDesc.findIndex((s) => s.signature === before);
      start = i < 0 ? allDesc.length : i + 1; // exclusive: start AFTER the anchor
    }
    return allDesc.slice(start, start + limit);
  };
}

// toBurn: mark every parsed sig a burn (parsing itself is covered elsewhere); echo the
// slot so the test can assert exactly which txs were collected.
const toBurn = async (signature, slot) => ({
  chain: "SOLANA",
  sourceId: signature,
  height: slot,
  from: "x",
  amountMilliViz: 1n,
  homeDestination: "acct",
  slot,
});

async function allBurnsCollectedAcrossPages() {
  // 25 final sigs, slot 100..76 desc; page size 10 => 3 pages.
  const all = [];
  for (let slot = 100; slot >= 76; slot--) all.push(sig(slot));
  const res = await paginateBurnsBySlot({
    fromSlot: 0,
    safeSlot: 1_000_000, // all final
    limit: 10,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.strictEqual(res.drained, true, "fully drained to history end");
  assert.strictEqual(res.burns.length, 25, "every burn collected, none dropped/duplicated");
  const slots = res.burns.map((b) => b.slot).sort((a, b) => a - b);
  assert.deepStrictEqual(slots, Array.from({ length: 25 }, (_, i) => 76 + i), "no gaps, no dupes across page anchors");
  assert.strictEqual(res.newestFinalSlot, 100, "newestFinalSlot = newest final slot");
  console.log("[solana-scan] multi-page drain collects all burns OK");
}

async function burstTruncatesFailsClosed() {
  // 100 sigs (slot 200..101), page size 10, but only 3 pages allowed => 30 scanned, 70 unseen.
  const all = [];
  for (let slot = 200; slot >= 101; slot--) all.push(sig(slot));
  const res = await paginateBurnsBySlot({
    fromSlot: 0,
    safeSlot: 1_000_000,
    limit: 10,
    maxScanPages: 3,
    fetchPage: makeFetch(all, 10),
    toBurn,
  });
  assert.strictEqual(res.drained, false, "burst beyond maxScanPages must report NOT drained (truncated)");
  assert.strictEqual(res.burns.length, 30, "only the scanned window is collected");
  // The caller (index.ts) keys fail-closed on drained===false: cursor stays, pause fires.
  // newestFinalSlot may be high, but the watcher MUST NOT use it while !drained.
  console.log("[solana-scan] burst > maxScanPages => drained=false (fail closed) OK");
}

async function notYetFinalTailExcluded() {
  // Newest 5 sigs (slot 100..96) are NOT final (safeSlot=95); older 10 (95..86) are final.
  const all = [];
  for (let slot = 100; slot >= 86; slot--) all.push(sig(slot));
  const res = await paginateBurnsBySlot({
    fromSlot: 0,
    safeSlot: 95,
    limit: 50, // one page
    maxScanPages: 50,
    fetchPage: makeFetch(all, 50),
    toBurn,
  });
  assert.strictEqual(res.drained, true, "drained (single short page = history end)");
  const slots = res.burns.map((b) => b.slot);
  assert.ok(Math.max(...slots) <= 95, "no non-final (slot>95) burn collected");
  assert.strictEqual(res.burns.length, 10, "exactly the 10 final burns collected");
  assert.strictEqual(res.newestFinalSlot, 95, "cursor advances only to the newest FINAL slot, not the fresh tip");
  console.log("[solana-scan] not-yet-final tail excluded, cursor stops at newest final OK");
}

async function failedSigsSkippedButWalked() {
  // Mix: some sigs errored. They are not burns, but pagination still walks them.
  const all = [sig(100), sig(99, "InstructionError"), sig(98), sig(97, "InstructionError"), sig(96)];
  const res = await paginateBurnsBySlot({
    fromSlot: 0,
    safeSlot: 1_000_000,
    limit: 50,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 50),
    toBurn,
  });
  assert.strictEqual(res.drained, true, "drained");
  const slots = res.burns.map((b) => b.slot).sort((a, b) => a - b);
  assert.deepStrictEqual(slots, [96, 98, 100], "failed sigs excluded as burns");
  assert.strictEqual(res.newestFinalSlot, 100, "newestFinalSlot from a successful sig");
  console.log("[solana-scan] failed signatures skipped as burns but still walked OK");
}

async function stopsAtCursor() {
  // Cursor at slot 90: sigs at/under it are already processed -> stop, don't collect them.
  const all = [];
  for (let slot = 95; slot >= 80; slot--) all.push(sig(slot));
  const res = await paginateBurnsBySlot({
    fromSlot: 90,
    safeSlot: 1_000_000,
    limit: 50,
    maxScanPages: 50,
    fetchPage: makeFetch(all, 50),
    toBurn,
  });
  assert.strictEqual(res.drained, true, "reached the cursor => drained");
  const slots = res.burns.map((b) => b.slot).sort((a, b) => a - b);
  assert.deepStrictEqual(slots, [91, 92, 93, 94, 95], "only slots strictly above the cursor collected");
  console.log("[solana-scan] stops at the cursor, no re-processing of old slots OK");
}

(async () => {
  await allBurnsCollectedAcrossPages();
  await burstTruncatesFailsClosed();
  await notYetFinalTailExcluded();
  await failedSigsSkippedButWalked();
  await stopsAtCursor();
  console.log("[solana-scan] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
