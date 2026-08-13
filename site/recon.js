// Live reconciliation card controller (landing page, Security section).
//
// ONE same-origin fetch of the coordinator's GET /recon — the figures recon itself
// reconciled, including unsweptFees, which no browser-side chain read can see.
//
// FAIL-SOFT, and specifically fail-QUIET: on any error, empty payload, or stale
// snapshot the card keeps its static illustration (equal full bars, "In sync") and no
// number is invented. Same rule as the token panel: hide rather than show a fallback.
//
// Pure math/formatting lives in recon-format.mjs (tested by tools/recon-meters-spike.cjs).
import { CONFIG } from "./config.js";
import {
  parseReconPayload, backingPct, meterFills,
  formatViz, formatDriftViz, formatAgo, isStale,
} from "./recon-format.mjs";

const CHAIN = "GRAM"; // the only live remote today; /recon is keyed per chain
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

function setVal(subId, valId, text) {
  const sub = $(subId), val = $(valId);
  if (!sub || !val) return;
  val.textContent = text;
  val.classList.remove("hidden");
  sub.classList.add("hidden");
}

function setBar(trackId, pct, valueText) {
  const track = $(trackId);
  if (!track) return;
  const fill = track.querySelector(".fill");
  if (fill) fill.style.width = pct + "%";
  track.setAttribute("aria-valuenow", String(pct));
  track.setAttribute("aria-valuetext", valueText);
}

function setStatus(text, cls) {
  const chip = $("rc-status"), label = $("rc-status-text");
  if (label) label.textContent = text;
  if (chip) {
    chip.classList.remove("paused", "warn");
    if (cls) chip.classList.add(cls);
  }
}

async function load() {
  let payload;
  try {
    const r = await fetch(CONFIG.rpc.coordinator + "/recon", { mode: "cors" });
    if (!r.ok) return; // 503 from the coordinator: keep the illustration
    payload = parseReconPayload(await r.json(), CHAIN);
  } catch (_) { return; }
  if (!payload) return; // no snapshot yet, or a partial one — say nothing

  // Circulating wVIZ as-is — the SAME figure the token panel and app.html show. Adding
  // unsweptFees here made this card display a third number that looked like a rival
  // supply figure. Unswept fees still count as backing owed in recon's own pause check
  // (server side, checker.ts); this card just doesn't re-state them.
  const owed = payload.circulating;
  const fills = meterFills(payload.locked, owed);
  const lockedLabel = formatViz(payload.locked);
  const owedLabel = formatViz(owed);
  if (owed === null || fills === null || lockedLabel === null || owedLabel === null) return;

  const stale = isStale(payload.checkedAt, Date.now());

  // Numbers first, then the bars: if a later step throws, the card is still truthful.
  setVal("rc-locked-sub", "rc-locked", lockedLabel + " VIZ");
  setVal("rc-owed-sub", "rc-owed", owedLabel + " wVIZ");

  // The invariant is locked ≥ circulating + unsweptFees, not equality: the gateway
  // deliberately carries a small surplus (retained activation surcharge). Say so.
  const eq = $("rc-eq");
  if (eq) eq.textContent = "≥";

  const card = $("rc-card");
  if (card) card.classList.add("live");
  document.querySelectorAll(".meter").forEach((m) => m.classList.add("live"));
  setBar("rc-track-a", fills.a, lockedLabel + " VIZ locked");
  setBar("rc-track-b", fills.b, owedLabel + " wVIZ backed");

  const pct = backingPct(payload.locked, owed);
  const ago = formatAgo(payload.checkedAt, Date.now());
  if (payload.paused) {
    setStatus("Paused", "paused");
  } else if (payload.status === "UNDER_BACKED") {
    setStatus("Under review", "paused");
  } else if (stale) {
    // The figures are the last known-good ones; don't present them as current.
    setStatus(ago ? "As of " + ago : "Not live", "warn");
  } else {
    setStatus(pct === null ? "In sync" : "Backed " + pct.toFixed(1) + "%", null);
  }

  const foot = $("rc-foot-text");
  const gap = payload.locked - payload.circulating; // matches the two bars above, not recon's structural drift
  if (foot && ago) {
    const surplus = formatDriftViz(gap);
    foot.textContent = gap > 0 && surplus
      ? `Checked ${ago} — ${surplus} VIZ of surplus backing. The whole system halts automatically the moment the two sides don't match.`
      : `Checked ${ago}. The whole system halts automatically the moment the two sides don't match.`;
  }
}

load();
setInterval(load, REFRESH_MS);
