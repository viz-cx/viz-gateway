import { CONFIG } from "./config.js";
import { isValidVizAccount, computePegInFee } from "./pegout.mjs";
import { isValidSolanaAddress, solanaPayUrl } from "./solana-bridge.mjs";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/* ---------- Theme / toast / copy / tabs ----------
   Kept in sync with app.js by hand. Deliberately NOT extracted into a shared
   module: app.js is the live GRAM money page and stays untouched by this app. */
(function theme() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const apply = (t) => {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("wviz-theme", t); } catch (e) {}
    if (meta) meta.setAttribute("content", t === "dark" ? "#060910" : "#eef2f8");
  };
  apply(root.getAttribute("data-theme") === "light" ? "light" : "dark");
  $("themeToggle")?.addEventListener("click", () =>
    apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));
})();

const toast = $("toast"), toastMsg = $("toastMsg");
let toastTimer;
function showToast(msg) {
  if (!toast) return;
  if (toastMsg) toastMsg.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1700);
}
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  try { await navigator.clipboard.writeText(btn.getAttribute("data-copy")); showToast("Copied!"); }
  catch (_) { showToast("Copy failed"); }
});

function selectTab(which, updateUrl = true) {
  const out = which === "out";
  $("tab-out").setAttribute("aria-selected", String(out));
  $("tab-in").setAttribute("aria-selected", String(!out));
  $("panel-out").classList.toggle("hidden", !out);
  $("panel-in").classList.toggle("hidden", out);
  if (updateUrl) {
    try { history.replaceState(null, "", "#" + (out ? "peg-out" : "peg-in")); } catch (e) {}
  }
}
$("tab-out").addEventListener("click", () => selectTab("out"));
$("tab-in").addEventListener("click", () => selectTab("in"));

function fmtViz(milli) { return (Number(milli) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 }); }

/* ---------- Peg-out: deposit-address lookup ---------- */
const acctInput = $("viz-acct"), amtInput = $("wviz-amt"), lookupBtn = $("pegout-lookup");

function validatePegout() {
  const acct = acctInput.value.trim();
  $("viz-acct-err").textContent = acct && !isValidVizAccount(acct) ? "Not a valid VIZ account name." : "";
  const amt = amtInput.value.trim();
  $("wviz-amt-err").textContent = amt && !/^\d+(\.\d+)?$/.test(amt) ? "Not a valid amount." : "";
  lookupBtn.disabled = !acct || !isValidVizAccount(acct);
}
acctInput.addEventListener("input", () => { $("pegout-result").classList.add("hidden"); validatePegout(); });
amtInput.addEventListener("input", validatePegout);

lookupBtn.addEventListener("click", async () => {
  const acct = acctInput.value.trim().toLowerCase();
  lookupBtn.disabled = true;
  lookupBtn.textContent = "Looking up…";
  try {
    const r = await fetch(
      `${CONFIG.rpc.coordinator}/solana/address?viz_account=${encodeURIComponent(acct)}`,
      { mode: "cors" },
    );
    const d = await r.json();
    if (!r.ok) {
      $("viz-acct-err").textContent =
        r.status === 404 ? "This account does not exist on VIZ." :
        r.status === 400 ? (d.error || "Invalid account name.") :
        "Gateway unavailable — try again shortly.";
      $("pegout-result").classList.add("hidden");
      return;
    }
    $("pegout-addr").textContent = d.address;
    $("pegout-addr-copy").setAttribute("data-copy", d.address);
    $("pegout-warning").textContent = d.warning || "";
    $("pegout-pay").href = solanaPayUrl({
      recipient: d.address,
      mint: d.mint || CONFIG.solana.mint,
      amount: amtInput.value.trim(),
    });
    $("pegout-result").classList.remove("hidden");
  } catch (_) {
    $("viz-acct-err").textContent = "Gateway unavailable — try again shortly.";
  } finally {
    lookupBtn.textContent = "Get deposit address";
    validatePegout();
  }
});

/* ---------- Peg-in: memo + fee preview ---------- */
let firstTimeSurcharge = true;
const solInput = $("sol-addr");

// Live fee policy, seeded from /fees on load (SOLANA columns). Static fallbacks
// mirror federation.json at the time of writing.
const fees = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: 10000n,
  mintGasFloorMilliViz: 1000n,
  refundFeeMilliViz: 5000n,
};

function renderFeesPanel() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("fee-floor", fmtViz(fees.floorMilliViz) + " VIZ");
  set("fee-bps", (fees.bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%");
  set("fee-activation", fmtViz(fees.activationSurchargeMilliViz) + " VIZ");
  set("fee-min", fmtViz(fees.mintGasFloorMilliViz) + " VIZ");
  set("fee-refund", fmtViz(fees.refundFeeMilliViz) + " VIZ");
}

async function loadFees() {
  try {
    const r = await fetch(`${CONFIG.rpc.coordinator}/fees`, { mode: "cors" });
    const d = await r.json();
    fees.floorMilliViz = BigInt(d.floorMilliViz.SOLANA);
    fees.bps = d.bps;
    fees.activationSurchargeMilliViz = BigInt(d.activationSurchargeMilliViz.SOLANA);
    fees.mintGasFloorMilliViz = BigInt(d.mintGasFloorMilliViz.SOLANA);
    fees.refundFeeMilliViz = BigInt(d.refundFeeMilliViz);
  } catch (_) { /* keep the seeded static values */ }
  renderFeesPanel();
  updatePegInFee();
}

// First-time surcharge = the user has no wVIZ token account yet (the gateway
// funds its creation). Direct RPC read; on any failure assume first-time so we
// never under-quote the fee.
async function hasWvizAccount(owner) {
  const r = await fetch(CONFIG.solana.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [owner, { mint: CONFIG.solana.mint }, { encoding: "jsonParsed" }],
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return (d.result?.value?.length ?? 0) > 0;
}

async function onSolAddrChange() {
  const addr = solInput.value.trim();
  const valid = isValidSolanaAddress(addr);
  $("sol-addr-err").textContent = addr && !valid ? "Not a valid Solana address." : "";
  if (!valid) {
    firstTimeSurcharge = true;
    updatePegInFee();
    updatePegInDeeplink();
    return;
  }
  try { firstTimeSurcharge = !(await hasWvizAccount(addr)); }
  catch (_) { firstTimeSurcharge = true; }
  updatePegInFee();
  updatePegInDeeplink();
}
solInput.addEventListener("input", onSolAddrChange);

function updatePegInFee() {
  const raw = $("pegin-amt").value.trim();
  const feeEl = $("pegin-fee"), netEl = $("pegin-net"), ftEl = $("pegin-firsttime");
  ftEl.textContent = firstTimeSurcharge
    ? `Includes a one-time ${fmtViz(fees.activationSurchargeMilliViz)} VIZ activation surcharge (first peg-in to this Solana address).`
    : "";
  if (!/^\d+(\.\d+)?$/.test(raw)) { feeEl.textContent = "—"; netEl.textContent = "—"; return; }
  const grossMilli = BigInt(Math.round(parseFloat(raw) * 1000));
  const { total } = computePegInFee({
    grossMilliViz: grossMilli,
    floorMilliViz: fees.floorMilliViz,
    bps: fees.bps,
    activationSurchargeMilliViz: fees.activationSurchargeMilliViz,
    walletDeployed: !firstTimeSurcharge,
  });
  const net = grossMilli - total;
  feeEl.textContent = fmtViz(total) + " VIZ";
  netEl.textContent = net > fees.mintGasFloorMilliViz ? fmtViz(net) + " wVIZ" : "too small — would be refunded";
}

// WebVIZWallet deep-link: pre-fills the peg-in transfer (account=solana.gate,
// the entered Solana address as memo). Only shown once the memo is valid.
function updatePegInDeeplink() {
  const el = $("pegin-open");
  const addr = solInput.value.trim();
  if (!isValidSolanaAddress(addr)) { el.classList.add("hidden"); return; }
  const raw = $("pegin-amt").value.trim();
  const params = [
    "account=" + encodeURIComponent(CONFIG.solana.vizAccount),
    "memo=" + encodeURIComponent(addr),
  ];
  if (/^\d+(\.\d+)?$/.test(raw)) {
    params.splice(1, 0, "amount=" + encodeURIComponent(String(parseFloat(raw))));
  }
  el.href = CONFIG.pegIn.walletTransferUrl + "?" + params.join("&");
  el.classList.remove("hidden");
}

$("pegin-amt").addEventListener("input", () => { updatePegInFee(); updatePegInDeeplink(); });

/* ---------- Live status (fail soft) ---------- */
function setItem(id, label, value) {
  const el = $(id);
  el.textContent = "";
  el.append(label + " ");
  const b = document.createElement("b");
  b.textContent = value;
  el.appendChild(b);
}
function hideItem(id) { $(id).classList.add("hidden"); }

// One /recon read covers both meters: SOLANA locked (VIZ side) + circulating
// (wVIZ supply), as published by the reconciliation loop.
async function loadStatus() {
  try {
    const r = await fetch(`${CONFIG.rpc.coordinator}/recon`, { mode: "cors" });
    const d = await r.json();
    const sol = d.chains?.SOLANA;
    if (!sol) { hideItem("st-reserve"); hideItem("st-supply"); return; }
    setItem("st-reserve", "VIZ locked", (sol.lockedMilliViz / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " VIZ");
    setItem("st-supply", "wVIZ circulating", (sol.circulatingMilliViz / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " wVIZ");
  } catch (_) { hideItem("st-reserve"); hideItem("st-supply"); }
}

async function loadHealth() {
  try {
    const r = await fetch(`${CONFIG.rpc.coordinator}/health`, { mode: "cors" });
    const h = await r.json();
    const el = $("st-health");
    el.textContent = "";
    if (h.paused) {
      const span = document.createElement("span");
      span.className = "warn";
      span.textContent = "⏸ Paused — new deposits discouraged";
      el.appendChild(span);
    } else {
      const span = document.createElement("span");
      span.className = "ok";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      span.appendChild(dot);
      span.append("Operational");
      el.appendChild(span);
    }
    el.classList.remove("hidden");
  } catch (_) { hideItem("st-health"); }
}

selectTab(location.hash === "#peg-in" ? "in" : "out", false);
validatePegout();
renderFeesPanel();
loadStatus(); loadHealth(); loadFees();
