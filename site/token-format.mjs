// Pure, dependency-free formatters + parsers for the wVIZ token panel.
// Runs in the browser (imported by token-stats.js / token.js) and in Node
// (tools/token-stats-spike.cjs). Mirrors site/pegout.mjs: one source of truth,
// no I/O. Callers hide their DOM row whenever a value is null.

// USD price with ~4 significant figures (VIZ is sub-cent, so fixed 2-dp is useless).
// Trailing zeros trimmed. null for null/NaN/non-positive so the row hides.
export function formatPriceUsd(n) {
  if (n == null || !isFinite(n) || n <= 0) return null;
  let s = Number(n).toPrecision(4);
  if (s.includes("e")) s = Number(n).toFixed(20); // avoid sci-notation for tiny values
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return "$" + s;
}

// Market cap in whole USD with thousands separators. circulatingViz is whole VIZ.
// null if either input is missing/invalid.
export function formatMarketCapUsd(priceUsd, circulatingViz) {
  if (priceUsd == null || !isFinite(priceUsd) || priceUsd <= 0) return null;
  if (circulatingViz == null || !isFinite(circulatingViz) || circulatingViz < 0) return null;
  return "$" + Math.round(priceUsd * circulatingViz).toLocaleString("en-US");
}

// Extract USD price from a STON.fi GET /v1/assets/<addr> response.
// Positive number, or null when there is no liquidity/price.
export function parseStonFiPrice(json) {
  const raw = json && json.asset ? json.asset.dex_price_usd : undefined;
  if (raw == null) return null;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? n : null;
}

// True circulating wVIZ = minter total − gateway-held (peg-out returns sit in the
// gateway's own jetton wallet, not burned). Never returns the raw total: that would
// overstate supply and contradict "VIZ locked". Floors at 0n. BigInt in/out.
export function computeCirculating(totalBaseUnits, heldBaseUnits) {
  return totalBaseUnits > heldBaseUnits ? totalBaseUnits - heldBaseUnits : 0n;
}

// Base units -> decimal number (e.g. 3-dp wVIZ). For display + market-cap math.
export function baseUnitsToNumber(baseUnits, decimals) {
  return Number(baseUnits) / 10 ** decimals;
}
