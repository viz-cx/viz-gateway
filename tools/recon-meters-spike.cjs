// SPIKE: pure math/formatters for the live reconciliation card (site/recon-format.mjs).
// Offline, dependency-free. Mirrors tools/token-stats-spike.cjs (dynamic-imports the ESM
// site module) and runs in `npm run verify` + CI.
//
// The load-bearing case is the OVER-BACKED one: the gateway deliberately holds more VIZ
// than it owes (retained activation surcharge), so `locked > circulating + unsweptFees`
// is normal and must render as "backed >100%", never as an error or a clipped bar.
//
// Run: node tools/recon-meters-spike.cjs
const assert = require("node:assert");

(async () => {
  const {
    parseReconPayload, reconChains, expectedLockedMilliViz, backingPct, meterFills,
    formatViz, formatDriftViz, formatAgo, isStale, STALE_AFTER_MS,
  } = await import("../site/recon-format.mjs");

  const CHECKED_AT = 1_754_300_000_000;
  const body = {
    ok: true,
    paused: false,
    chains: {
      GRAM: {
        lockedMilliViz: 43_547_500,
        circulatingMilliViz: 43_500_000,
        unsweptFeesMilliViz: 0,
        driftMilliViz: 47_500,
        status: "OK",
        checkedAt: CHECKED_AT,
      },
    },
  };

  // --- parseReconPayload: normalize, or refuse ---
  const p = parseReconPayload(body, "GRAM");
  assert.strictEqual(p.locked, 43_547_500);
  assert.strictEqual(p.drift, 47_500);
  assert.strictEqual(p.status, "OK");
  assert.strictEqual(p.paused, false);
  assert.strictEqual(parseReconPayload(body, "SOLANA"), null, "unconfigured chain -> null");
  assert.strictEqual(parseReconPayload({ ok: true, chains: {} }, "GRAM"), null, "empty map -> null");
  assert.strictEqual(parseReconPayload({ ok: false, error: "x" }, "GRAM"), null, "503 body -> null");
  assert.strictEqual(parseReconPayload(null, "GRAM"), null);
  assert.strictEqual(parseReconPayload(undefined, "GRAM"), null);
  assert.strictEqual(parseReconPayload("nope", "GRAM"), null);
  assert.strictEqual(parseReconPayload({ ok: true, chains: { GRAM: {} } }, "GRAM"), null);
  // A partial row must be refused outright rather than rendered with holes.
  for (const field of ["lockedMilliViz", "circulatingMilliViz", "unsweptFeesMilliViz", "driftMilliViz", "checkedAt", "status"]) {
    const row = { ...body.chains.GRAM };
    delete row[field];
    assert.strictEqual(parseReconPayload({ ok: true, chains: { GRAM: row } }, "GRAM"), null, `missing ${field}`);
  }
  assert.strictEqual(
    parseReconPayload({ ok: true, chains: { GRAM: { ...body.chains.GRAM, status: "WAT" } } }, "GRAM"),
    null, "unknown status -> null",
  );
  assert.strictEqual(parseReconPayload({ ...body, paused: true }, "GRAM").paused, true);
  console.log("[recon-card] parseReconPayload OK");

  // --- reconChains: every live chain, sorted, each fully normalized ---
  // Single-chain body (production today) yields exactly one entry, tagged.
  const one = reconChains(body);
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].chain, "GRAM");
  assert.strictEqual(one[0].locked, 43_547_500);
  assert.strictEqual(one[0].paused, false);

  // Two live chains come back sorted by name (SOLANA before... no: GRAM < SOLANA),
  // so the render order is deterministic regardless of object key order.
  const twoBody = {
    ok: true,
    paused: false,
    chains: {
      SOLANA: {
        lockedMilliViz: 10_000_000, circulatingMilliViz: 9_990_000,
        unsweptFeesMilliViz: 5_000, driftMilliViz: 5_000, status: "OK", checkedAt: CHECKED_AT,
      },
      GRAM: body.chains.GRAM,
    },
  };
  const two = reconChains(twoBody);
  assert.deepStrictEqual(two.map((c) => c.chain), ["GRAM", "SOLANA"], "sorted by chain name");
  assert.strictEqual(two[1].locked, 10_000_000);

  // A partial/invalid row is dropped, not rendered — the healthy chain still shows.
  const mixed = {
    ok: true, paused: false,
    chains: { GRAM: body.chains.GRAM, SOLANA: { lockedMilliViz: 1 /* rest missing */ } },
  };
  assert.deepStrictEqual(reconChains(mixed).map((c) => c.chain), ["GRAM"], "partial chain omitted");

  // The top-level paused flag propagates to every card.
  assert.ok(reconChains({ ...twoBody, paused: true }).every((c) => c.paused === true));

  // Nothing usable -> [] so the caller keeps the static illustration.
  assert.deepStrictEqual(reconChains({ ok: true, chains: {} }), []);
  assert.deepStrictEqual(reconChains({ ok: false }), []);
  assert.deepStrictEqual(reconChains(null), []);
  assert.deepStrictEqual(reconChains("nope"), []);
  assert.deepStrictEqual(reconChains({ ok: true }), [], "no chains map -> []");
  console.log("[recon-card] reconChains OK");

  // --- expectedLockedMilliViz: unswept fees are backing OWED, not surplus ---
  assert.strictEqual(expectedLockedMilliViz(43_500_000, 0), 43_500_000);
  assert.strictEqual(expectedLockedMilliViz(43_500_000, 37_500), 43_537_500);
  assert.strictEqual(expectedLockedMilliViz(null, 0), null);
  assert.strictEqual(expectedLockedMilliViz(0, undefined), null);
  console.log("[recon-card] expectedLockedMilliViz OK");

  // --- backingPct: the over-backed reality, 1 dp ---
  assert.strictEqual(backingPct(43_547_500, 43_500_000), 100.1, "structural surplus reads just over 100%");
  assert.strictEqual(backingPct(1_000, 1_000), 100);
  assert.strictEqual(backingPct(500, 1_000), 50, "under-backed reads below 100 (never clamped up)");
  assert.strictEqual(backingPct(2_000, 1_000), 200);
  assert.strictEqual(backingPct(1_000, 0), null, "nothing owed -> undefined ratio, not Infinity");
  assert.strictEqual(backingPct(0, 0), null);
  assert.strictEqual(backingPct(null, 1_000), null);
  assert.strictEqual(backingPct(1_000, null), null);
  console.log("[recon-card] backingPct OK");

  // --- meterFills: scaled to the LARGER side, so the honest bar is full ---
  const f = meterFills(43_547_500, 43_500_000);
  assert.strictEqual(f.a, 100, "locked is the larger side -> full bar");
  assert.strictEqual(f.b, 99.9, "owed is a hair shorter — the visible surplus");
  assert.ok(f.b < f.a, "over-backed must not render as equal bars");

  const under = meterFills(40_000_000, 50_000_000);
  assert.strictEqual(under.b, 100, "when owed exceeds locked, OWED is the full bar");
  assert.strictEqual(under.a, 80);
  assert.ok(under.a < under.b, "under-backing must be visible, not hidden");

  assert.deepStrictEqual(meterFills(1_000, 1_000), { a: 100, b: 100 });
  // A tiny-but-real side still gets a visible sliver; a genuine zero gets nothing.
  assert.strictEqual(meterFills(1_000_000, 1).b, 2, "tiny non-zero floors at the min visible width");
  assert.strictEqual(meterFills(1_000_000, 0).b, 0, "exact zero renders as an empty track");
  assert.strictEqual(meterFills(0, 0), null, "nothing to draw at all");
  assert.strictEqual(meterFills(null, 1_000), null);
  assert.strictEqual(meterFills(-1, 1_000), null);
  // Widths are always renderable percentages.
  for (const [l, e] of [[1, 999_999], [999_999, 1], [7, 7], [0, 5]]) {
    const w = meterFills(l, e);
    for (const v of [w.a, w.b]) assert.ok(v >= 0 && v <= 100, `width ${v} out of range`);
  }
  console.log("[recon-card] meterFills OK");

  // --- formatViz / formatDriftViz: mVIZ -> VIZ, deterministic locale ---
  assert.strictEqual(formatViz(43_547_500), "43,548", "whole VIZ, thousands-separated");
  assert.strictEqual(formatViz(47_500), "48");
  assert.strictEqual(formatViz(0), "0");
  assert.strictEqual(formatViz(47_500, 3), "47.5", "fractional VIZ when asked");
  assert.strictEqual(formatViz(null), null);
  assert.strictEqual(formatViz(NaN), null);
  assert.strictEqual(formatDriftViz(47_500), "+47.5", "surplus is signed");
  assert.strictEqual(formatDriftViz(-3_912_500), "-3,912.5");
  assert.strictEqual(formatDriftViz(0), "0");
  assert.strictEqual(formatDriftViz(null), null);
  console.log("[recon-card] formatViz OK");

  // --- freshness: invalid input is STALE (fail safe), skew clamps to "just now" ---
  assert.strictEqual(isStale(CHECKED_AT, CHECKED_AT + 1_000), false);
  assert.strictEqual(isStale(CHECKED_AT, CHECKED_AT + STALE_AFTER_MS + 1), true);
  assert.strictEqual(isStale(null, CHECKED_AT), true, "no timestamp must never read as live");
  assert.strictEqual(isStale(CHECKED_AT, null), true);

  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT + 1_000), "just now");
  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT + 12_000), "12s ago");
  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT + 180_000), "3m ago");
  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT + 7_200_000), "2h ago");
  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT + 172_800_000), "2d ago");
  assert.strictEqual(formatAgo(CHECKED_AT, CHECKED_AT - 5_000), "just now", "clock skew must not print a negative age");
  assert.strictEqual(formatAgo(null, CHECKED_AT), null);
  console.log("[recon-card] formatAgo/isStale OK");

  // --- end-to-end: the live production shape renders the intended card ---
  const live = parseReconPayload(body, "GRAM");
  const owed = expectedLockedMilliViz(live.circulating, live.unswept);
  assert.strictEqual(formatViz(live.locked) + " VIZ", "43,548 VIZ");
  assert.strictEqual(formatViz(owed) + " wVIZ", "43,500 wVIZ");
  assert.strictEqual(backingPct(live.locked, owed).toFixed(1), "100.1");
  assert.deepStrictEqual(meterFills(live.locked, owed), { a: 100, b: 99.9 });
  console.log("[recon-card] production shape OK");

  console.log("[recon-card] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
