// Live reconciliation cards (landing page, Security section) — one per chain the
// coordinator reconciles (GRAM today, SOLANA once live).
//
// ONE same-origin fetch of the coordinator's GET /recon — the figures recon itself
// reconciled, including unsweptFees, which no browser-side chain read can see. The
// endpoint returns a per-chain map; this controller renders a card for every chain
// with a live snapshot and leaves the rest out.
//
// FAIL-SOFT, and specifically fail-QUIET: on any error, empty payload, or a body
// with no usable chain, the static illustration (equal full bars, "In sync") stays
// and no number is invented. Same rule as the token panel: hide rather than show a
// fallback. A card only replaces the static illustration once at least one chain
// renders live. Fail-quiet is PER CHAIN: each chain's last good snapshot is kept, so
// one chain degrading on a refresh keeps its last good card (aging into "As of …"
// via checkedAt) instead of vanishing while its neighbour stays live.
//
// Pure math/formatting lives in recon-format.mjs (tested by tools/recon-meters-spike.cjs).
import { CONFIG } from "./config.js";
import {
  reconChains, backingPct, meterFills,
  formatViz, formatDriftViz, formatAgo, isStale,
} from "./recon-format.mjs";

const REFRESH_MS = 60_000;

// Human labels for the per-card chain badge. An unknown chain falls back to its
// raw name so a newly-wired remote still renders (just without a pretty label).
const CHAIN_LABEL = { GRAM: "TON", SOLANA: "Solana" };

const $ = (id) => document.getElementById(id);

function setVal(card, cls, text) {
  const val = card.querySelector("." + cls);
  const sub = card.querySelector("." + cls + "-sub");
  if (!val) return;
  val.textContent = text;
  val.classList.remove("hidden");
  if (sub) sub.classList.add("hidden");
}

function setBar(card, cls, pct, valueText) {
  const track = card.querySelector("." + cls);
  if (!track) return;
  const fill = track.querySelector(".fill");
  if (fill) fill.style.width = pct + "%";
  track.setAttribute("aria-valuenow", String(pct));
  track.setAttribute("aria-valuetext", valueText);
}

function setStatus(card, text, cls) {
  const chip = card.querySelector(".rc-status");
  const label = card.querySelector(".rc-status-text");
  if (label) label.textContent = text;
  if (chip) {
    chip.classList.remove("paused", "warn");
    if (cls) chip.classList.add(cls);
  }
}

// Render one chain's snapshot into a fresh clone of the #rc-tpl template. Returns
// the card element, or null if the figures are unusable (so the caller can skip it
// without leaving a half-drawn card).
function renderCard(tpl, payload, now) {
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector(".rc-card");
  if (!card) return null;

  // Circulating wVIZ as-is — the SAME figure the token panel and app.html show. Adding
  // unsweptFees here made this card display a third number that looked like a rival
  // supply figure. Unswept fees still count as backing owed in recon's own pause check
  // (server side, checker.ts); this card just doesn't re-state them.
  const owed = payload.circulating;
  const fills = meterFills(payload.locked, owed);
  const lockedLabel = formatViz(payload.locked);
  const owedLabel = formatViz(owed);
  if (owed === null || fills === null || lockedLabel === null || owedLabel === null) return null;

  const stale = isStale(payload.checkedAt, now);

  const badge = card.querySelector(".rc-chain");
  if (badge) badge.textContent = CHAIN_LABEL[payload.chain] ?? payload.chain;

  // Numbers first, then the bars: if a later step throws, the card is still truthful.
  setVal(card, "rc-locked", lockedLabel + " VIZ");
  setVal(card, "rc-owed", owedLabel + " wVIZ");

  // The invariant is locked ≥ circulating + unsweptFees, not equality: the gateway
  // deliberately carries a small surplus (retained activation surcharge). Say so.
  const eq = card.querySelector(".rc-eq");
  if (eq) eq.textContent = "≥";

  card.classList.add("live");
  card.querySelectorAll(".meter").forEach((m) => m.classList.add("live"));
  setBar(card, "rc-track-a", fills.a, lockedLabel + " VIZ locked");
  setBar(card, "rc-track-b", fills.b, owedLabel + " wVIZ backed");

  const pct = backingPct(payload.locked, owed);
  const ago = formatAgo(payload.checkedAt, now);
  if (payload.paused) {
    setStatus(card, "Paused", "paused");
  } else if (payload.status === "UNDER_BACKED") {
    setStatus(card, "Under review", "paused");
  } else if (stale) {
    // The figures are the last known-good ones; don't present them as current.
    setStatus(card, ago ? "As of " + ago : "Not live", "warn");
  } else {
    setStatus(card, pct === null ? "In sync" : "Backed " + pct.toFixed(1) + "%", null);
  }

  const foot = card.querySelector(".rc-foot-text");
  const gap = payload.locked - payload.circulating; // matches the two bars above, not recon's structural drift
  if (foot && ago) {
    const surplus = formatDriftViz(gap);
    foot.textContent = gap > 0 && surplus
      ? `Checked ${ago} — ${surplus} VIZ of surplus backing. The whole system halts automatically the moment the two sides don't match.`
      : `Checked ${ago}. The whole system halts automatically the moment the two sides don't match.`;
  }
  return card;
}

// Last good snapshot per chain. Rendering always goes through this cache: a chain
// whose row turns partial/unusable on one refresh keeps its previous figures (and its
// status honestly ages to "As of …" through checkedAt) rather than dropping out.
const lastGood = new Map();

async function load() {
  const container = $("rc-cards");
  const tpl = $("rc-tpl");
  if (!container || !tpl) return;

  let json;
  try {
    const r = await fetch(CONFIG.rpc.coordinator + "/recon", { mode: "cors" });
    if (!r.ok) return; // 503 from the coordinator: keep whatever is showing
    json = await r.json();
  } catch (_) { return; }

  for (const payload of reconChains(json)) lastGood.set(payload.chain, payload);
  if (lastGood.size === 0) return; // never had a usable chain — keep the static illustration

  const now = Date.now();
  const cards = [];
  for (const chain of [...lastGood.keys()].sort()) {
    const card = renderCard(tpl, lastGood.get(chain), now);
    if (card) cards.push(card);
  }
  if (cards.length === 0) return; // nothing renderable even from cache — leave prior render

  // Swap in the freshly-rendered cards, replacing the static illustration (or the
  // previous refresh's cards) in one shot so there is never a half-updated panel.
  container.replaceChildren(...cards);
}

load();
setInterval(load, REFRESH_MS);
