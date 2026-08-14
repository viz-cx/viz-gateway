// Pure, dependency-free math + formatters for the live reconciliation card on the
// landing page (#how). Runs in the browser (imported by site/recon.js) and in Node
// (tools/recon-meters-spike.cjs). Mirrors site/token-format.mjs: no I/O, and every
// function returns null on unusable input so the caller leaves the static/decorative
// state in place rather than rendering a wrong number.

// A snapshot older than this is not shown as live. Recon ticks every 30s by default
// (RECON_INTERVAL_MS), so this tolerates a slow tick plus a few indeterminate ones
// before the card admits it is stale.
export const STALE_AFTER_MS = 300_000;

// Smallest bar width that still reads as a bar. A real but tiny side must not render
// as an empty track (which looks like "zero backing").
const MIN_VISIBLE_PCT = 2;

function finiteNumber(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/**
 * Normalize one chain's entry from a GET /recon body. Returns null unless every
 * figure is present and finite — a partial payload must not be rendered.
 * `paused` comes from the top level (the endpoint bundles it so the card needs one fetch).
 */
export function parseReconPayload(json, chain) {
  if (!json || typeof json !== "object") return null;
  if (json.ok === false) return null;
  const entry = json.chains && typeof json.chains === "object" ? json.chains[chain] : undefined;
  if (!entry || typeof entry !== "object") return null;

  const locked = finiteNumber(entry.lockedMilliViz);
  const circulating = finiteNumber(entry.circulatingMilliViz);
  const unswept = finiteNumber(entry.unsweptFeesMilliViz);
  const drift = finiteNumber(entry.driftMilliViz);
  const checkedAt = finiteNumber(entry.checkedAt);
  if (locked === null || circulating === null || unswept === null || drift === null || checkedAt === null) return null;
  if (entry.status !== "OK" && entry.status !== "UNDER_BACKED") return null;

  return {
    locked, circulating, unswept, drift,
    status: entry.status,
    checkedAt,
    paused: json.paused === true,
  };
}

/**
 * Every chain present in a GET /recon body, each normalized through
 * parseReconPayload, sorted by chain name for a deterministic render order.
 * Returns [] when the body carries no usable chain (bad body, empty map, or every
 * row partial) so the caller leaves the static illustration standing rather than
 * rendering an empty panel. Each element is the parsed snapshot plus its `chain`.
 *
 * This is the multi-chain generalization of parseReconPayload(json, chain): the
 * card no longer hardcodes a single remote (GRAM) — it draws one meter card per
 * chain the coordinator reconciles (GRAM today, SOLANA once it is live), and a
 * chain that has no snapshot yet is simply absent from the list.
 */
export function reconChains(json) {
  if (!json || typeof json !== "object") return [];
  const map = json.chains && typeof json.chains === "object" ? json.chains : null;
  if (!map) return [];
  const out = [];
  for (const chain of Object.keys(map).sort()) {
    const parsed = parseReconPayload(json, chain);
    if (parsed) out.push({ chain, ...parsed });
  }
  return out;
}

/**
 * Backing the peg owes: circulating wVIZ PLUS fees minted-but-not-yet-swept. The
 * unswept part is why `locked` legitimately exceeds `circulating` — the card compares
 * against this, not against circulating alone, or it would misreport the surplus.
 */
export function expectedLockedMilliViz(circulating, unswept) {
  const c = finiteNumber(circulating), u = finiteNumber(unswept);
  if (c === null || u === null) return null;
  return c + u;
}

/**
 * locked as a percentage of what is owed, 1 dp. 100.1 = over-backed by 0.1%.
 * null when nothing is owed (0 circulating ⇒ the ratio is undefined, not infinite)
 * so the caller hides the figure instead of printing Infinity.
 */
export function backingPct(locked, expected) {
  const l = finiteNumber(locked), e = finiteNumber(expected);
  if (l === null || e === null || e <= 0 || l < 0) return null;
  return Math.round((l / e) * 1000) / 10;
}

/**
 * Widths for the two bars, as percentages of the LARGER side — so the bigger pool is
 * always full and the other is proportional to it. With the usual small over-backing
 * this renders as two near-identical bars, which is the honest picture: `locked` is a
 * hair longer than `circulating + unswept`.
 * null when there is nothing to draw (both sides zero, or invalid input).
 */
export function meterFills(locked, expected) {
  const l = finiteNumber(locked), e = finiteNumber(expected);
  if (l === null || e === null || l < 0 || e < 0) return null;
  const max = Math.max(l, e);
  if (max <= 0) return null;
  const pct = (v) => {
    if (v <= 0) return 0;
    const raw = (v / max) * 100;
    return Math.round(Math.max(raw, MIN_VISIBLE_PCT) * 10) / 10;
  };
  return { a: pct(l), b: pct(e) };
}

/**
 * mVIZ -> display string in whole VIZ (thousands-separated). Locale pinned to en-US so
 * the rendering is deterministic and testable; the unit is added by the caller, which
 * knows whether it is VIZ or wVIZ.
 */
export function formatViz(milliViz, maxFractionDigits = 0) {
  const m = finiteNumber(milliViz);
  if (m === null) return null;
  return (m / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}

/** Signed VIZ, for the surplus/deficit line: "+47.5" / "-3,912.5". */
export function formatDriftViz(driftMilliViz) {
  const s = formatViz(driftMilliViz, 3);
  if (s === null) return null;
  return driftMilliViz > 0 ? "+" + s : s;
}

/** True once a snapshot is too old to present as live. Invalid input ⇒ stale (fail safe). */
export function isStale(checkedAt, now, maxAgeMs = STALE_AFTER_MS) {
  const c = finiteNumber(checkedAt), n = finiteNumber(now);
  if (c === null || n === null) return true;
  return n - c > maxAgeMs;
}

/**
 * Human age of a snapshot. Small negative deltas (clock skew between the browser and
 * the coordinator) clamp to "just now" rather than printing a negative age.
 */
export function formatAgo(checkedAt, now) {
  const c = finiteNumber(checkedAt), n = finiteNumber(now);
  if (c === null || n === null) return null;
  const ms = Math.max(0, n - c);
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
