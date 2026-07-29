// Landing "Token" section controller. Static links render immediately from CONFIG;
// live figures (price, market cap, circulating, VIZ locked) load fail-soft — each
// row stays hidden until its value is available, so the price self-activates when a
// DEX indexes a pool. Copy button + toast are handled by index.html's inline IIFE.
import { CONFIG } from "./config.js";
import { fetchCirculatingSupply, fetchVizLocked, fetchWvizPriceUsd } from "./token-stats.js";
import { formatPriceUsd, formatMarketCapUsd, baseUnitsToNumber } from "./token-format.mjs";

const $ = (id) => document.getElementById(id);
const show = (id) => $(id)?.classList.remove("hidden");
const hide = (id) => $(id)?.classList.add("hidden");
const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; };

// Static links (no network) — render on load.
(function staticLinks() {
  const a = CONFIG.wviz.minter;
  $("tok-explorer")?.setAttribute("href", CONFIG.dex.explorerUrl + a);
  $("tok-stonfi")?.setAttribute("href", CONFIG.dex.stonfiSwapUrl + a);
  $("tok-dedust")?.setAttribute("href", CONFIG.dex.dedustSwapUrl + a);
})();

let anyLive = false;
function markLive() { if (!anyLive) { anyLive = true; hide("tok-empty"); } }

async function loadMarket() {
  const [price, circ] = await Promise.all([fetchWvizPriceUsd(), fetchCirculatingSupply()]);

  const priceLabel = formatPriceUsd(price);
  if (priceLabel) { setText("tok-price", priceLabel); show("tok-price-row"); markLive(); }
  else hide("tok-price-row");

  const circWhole = circ === null ? null : baseUnitsToNumber(circ, CONFIG.wviz.decimals);
  if (circWhole !== null) {
    setText("tok-supply", circWhole.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " wVIZ");
    show("tok-supply-row"); markLive();
  } else hide("tok-supply-row");

  const capLabel = formatMarketCapUsd(price, circWhole);
  if (capLabel) { setText("tok-mcap", capLabel); show("tok-mcap-row"); markLive(); }
  else hide("tok-mcap-row");
}

async function loadLocked() {
  const bal = await fetchVizLocked();
  if (bal === null) { hide("tok-locked-row"); return; }
  setText("tok-locked", bal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " VIZ");
  show("tok-locked-row"); markLive();
}

loadMarket();
loadLocked();
