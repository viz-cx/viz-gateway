// Shared, browser-only live-data fetchers for the wVIZ token panels (landing +
// app). Every function is FAIL-SOFT: returns null on any error and never throws,
// so a consumer just hides its row. Pure math/parse lives in token-format.mjs.
import { CONFIG } from "./config.js";
import { computeCirculating, parseStonFiPrice } from "./token-format.mjs";
import { TonClient, Address } from "https://esm.sh/@ton/ton@15";

const ton = new TonClient({ endpoint: CONFIG.rpc.toncenter });

// toncenter's public endpoint rate-limits (429) and flakes; retry with backoff.
async function withRetry(fn, { tries = 6, delay = 700 } = {}) {
  let wait = delay;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

// Circulating wVIZ (base units) = minter total supply − gateway-held. Returns null
// if either read fails — never the raw total (would overstate + contradict backing).
export async function fetchCirculatingSupply() {
  try {
    const jd = await withRetry(() => ton.runMethod(Address.parse(CONFIG.wviz.minter), "get_jetton_data", []));
    const total = jd.stack.readBigNumber();
    const gw = await withRetry(() => ton.runMethod(Address.parse(CONFIG.wviz.gatewayJettonWallet), "get_wallet_data", []));
    const held = gw.stack.readBigNumber();
    return computeCirculating(total, held);
  } catch (_) { return null; }
}

// VIZ (float) locked in the gateway account, via the VIZ node. null on failure.
// Tries each node in CONFIG.rpc.viz in order: a degraded node returns an empty
// `result: []` (not an error) for every account, so an empty/missing account is
// treated as a miss and we fall through to the next node — never surface it as 0.
export async function fetchVizLocked() {
  const nodes = Array.isArray(CONFIG.rpc.viz) ? CONFIG.rpc.viz : [CONFIG.rpc.viz];
  for (const node of nodes) {
    try {
      const r = await fetch(node, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: ["database_api", "get_accounts", [[CONFIG.pegIn.vizAccount]]] }),
      });
      const j = await r.json();
      const acct = j?.result?.[0] ?? j?.result?.accounts?.[0];
      const bal = parseFloat(String(acct?.balance ?? "").replace(/[^\d.]/g, ""));
      if (isFinite(bal)) return bal;
    } catch (_) { /* try next node */ }
  }
  return null;
}

// wVIZ USD price from STON.fi. null while there is no pool (dex_price_usd absent).
// Self-activates: the row appears the moment STON.fi indexes a price. (DeDust price
// derivation is deferred per spec; the DeDust Trade link ships regardless.)
export async function fetchWvizPriceUsd() {
  try {
    const r = await fetch(CONFIG.dex.stonfiAssetUrl + encodeURIComponent(CONFIG.wviz.minter), { mode: "cors" });
    if (!r.ok) return null;
    return parseStonFiPrice(await r.json());
  } catch (_) { return null; }
}
