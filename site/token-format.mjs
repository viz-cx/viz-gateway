// Pure, dependency-free formatters + parsers for the wVIZ token panel.
// Runs in the browser (imported by token-stats.js / token.js) and in Node
// (tools/token-stats-spike.cjs). Mirrors site/pegout.mjs: one source of truth,
// no I/O. Callers hide their DOM row whenever a value is null.

// USD price with ~4 significant figures (VIZ is sub-cent, so fixed 2-dp is useless).
// Trailing zeros trimmed. null for null/NaN/non-positive so the row hides.
export function formatPriceUsd(n) {
  if (n == null || !isFinite(n) || n <= 0) return null;
  let s = Number(n).toPrecision(4);
  if (s.includes("e")) s = Number(s).toFixed(20); // avoid sci-notation for tiny values
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return "$" + s;
}

// Market cap in whole USD with thousands separators. circulatingViz is whole VIZ.
// null if either input is missing/invalid.
export function formatMarketCapUsd(priceUsd, circulatingViz) {
  if (priceUsd == null || !isFinite(priceUsd) || priceUsd <= 0) return null;
  if (circulatingViz == null || !isFinite(circulatingViz) || circulatingViz <= 0) return null;
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

// Extract { priceUsd, tvlUsd } from a Raydium GET /pools/info/ids response for the
// wVIZ/USDT pool (USDT taken as $1). `price` is mintB per mintA, so invert when wVIZ
// is mintB. Each field is a positive number or null; null overall if the pool is absent.
export function parseRaydiumPool(json, wvizMint) {
  const p = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!p || !p.mintA || !p.mintB) return null;
  const pos = (n) => (isFinite(n) && n > 0 ? n : null);
  const raw = Number(p.price);
  const priceUsd = p.mintA.address === wvizMint ? pos(raw)
    : p.mintB.address === wvizMint ? pos(1 / raw) : null;
  return { priceUsd, tvlUsd: pos(Number(p.tvl)) };
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
