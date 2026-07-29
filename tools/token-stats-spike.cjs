// SPIKE: pure formatters/parsers for the wVIZ token panel (site/token-format.mjs).
// Offline, dependency-free. Mirrors tools/wviz-app-payload-spike.cjs (dynamic-imports
// the ESM site module) and runs in `npm run verify` + CI.
//
// Run: node tools/token-stats-spike.cjs
const assert = require("node:assert");

(async () => {
  const {
    formatPriceUsd, formatMarketCapUsd, parseStonFiPrice,
    computeCirculating, baseUnitsToNumber,
  } = await import("../site/token-format.mjs");

  // --- formatPriceUsd: sig-figs, trim, fail-soft ---
  assert.strictEqual(formatPriceUsd(0.00033787850498645673), "$0.0003379"); // 4 sig figs
  assert.strictEqual(formatPriceUsd(1.23456), "$1.235");
  assert.strictEqual(formatPriceUsd(1000), "$1000");
  assert.strictEqual(formatPriceUsd(null), null);
  assert.strictEqual(formatPriceUsd(0), null);
  assert.strictEqual(formatPriceUsd(-5), null);
  assert.strictEqual(formatPriceUsd(NaN), null);
  console.log("[token] formatPriceUsd OK");

  // --- formatMarketCapUsd: whole $ with separators, fail-soft ---
  assert.strictEqual(formatMarketCapUsd(0.0003379, 243007408), "$82,112"); // 0.0003379*243007408≈82112
  assert.strictEqual(formatMarketCapUsd(2, 1000), "$2,000");
  assert.strictEqual(formatMarketCapUsd(null, 1000), null);
  assert.strictEqual(formatMarketCapUsd(1, null), null);
  assert.strictEqual(formatMarketCapUsd(0, 1000), null);
  console.log("[token] formatMarketCapUsd OK");

  // --- parseStonFiPrice: field extraction + no-liquidity null ---
  assert.strictEqual(parseStonFiPrice({ asset: { dex_price_usd: "0.00033787850498645673" } }), 0.00033787850498645673);
  assert.strictEqual(parseStonFiPrice({ asset: { dex_price_usd: null, tags: ["no_liquidity"] } }), null);
  assert.strictEqual(parseStonFiPrice({ asset: {} }), null);
  assert.strictEqual(parseStonFiPrice({}), null);
  assert.strictEqual(parseStonFiPrice(null), null);
  console.log("[token] parseStonFiPrice OK");

  // --- computeCirculating: total − held, floored, never raw total ---
  assert.strictEqual(computeCirculating(1000n, 300n), 700n);
  assert.strictEqual(computeCirculating(300n, 1000n), 0n); // held > total -> 0, not negative
  assert.strictEqual(computeCirculating(500n, 500n), 0n);
  console.log("[token] computeCirculating OK");

  // --- baseUnitsToNumber: 3-decimal scaling ---
  assert.strictEqual(baseUnitsToNumber(243007408000n, 3), 243007408);
  assert.strictEqual(baseUnitsToNumber(1500n, 3), 1.5);
  console.log("[token] baseUnitsToNumber OK");

  console.log("token-format spike: ALL PASS");
})();
