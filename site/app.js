import { CONFIG } from "./config.js";
import { buildPegoutBody, wvizToBaseUnits, isValidVizAccount, computePegInFee } from "./pegout.mjs";
import { TonConnectUI } from "https://esm.sh/@tonconnect/ui@2";
import { TonClient, JettonMaster, beginCell, Address, toNano } from "https://esm.sh/@ton/ton@15";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/* ---------- Theme ---------- */
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

/* ---------- Toast + copy (same behavior as the landing page) ---------- */
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

/* ---------- Tabs ---------- */
function selectTab(which) {
  const out = which === "out";
  $("tab-out").setAttribute("aria-selected", String(out));
  $("tab-in").setAttribute("aria-selected", String(!out));
  $("panel-out").classList.toggle("hidden", !out);
  $("panel-in").classList.toggle("hidden", out);
}
$("tab-out").addEventListener("click", () => selectTab("out"));
$("tab-in").addEventListener("click", () => selectTab("in"));

/* ---------- TON Connect ---------- */
const tonConnectUI = new TonConnectUI({
  manifestUrl: CONFIG.siteUrl + "tonconnect-manifest.json",
  buttonRootId: "tonConnectButton",
});
const ton = new TonClient({ endpoint: CONFIG.rpc.toncenter });
let userAddress = null; // friendly string when connected

// toncenter's public endpoint rate-limits hard (HTTP 429) and flakes; retry with
// exponential backoff so balance/deployment reads survive transient failures.
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

async function walletAddressOf(owner) {
  const master = ton.open(JettonMaster.create(Address.parse(CONFIG.wviz.minter)));
  return withRetry(() => master.getWalletAddress(Address.parse(owner)));
}

/* ---------- Peg-out ---------- */
const acctInput = $("viz-acct"), amtInput = $("wviz-amt"), sendBtn = $("pegout-send");

function validatePegout() {
  let ok = true;
  const acct = acctInput.value.trim();
  if (!userAddress) { sendBtn.textContent = "Connect wallet to continue"; sendBtn.disabled = false; return; }
  sendBtn.textContent = "Return wVIZ";
  $("viz-acct-err").textContent = acct && !isValidVizAccount(acct) ? "Not a valid VIZ account name." : "";
  if (!acct || !isValidVizAccount(acct)) ok = false;
  let amtErr = "";
  try { if (amtInput.value.trim()) wvizToBaseUnits(amtInput.value, CONFIG.wviz.decimals); else ok = false; }
  catch (e) { amtErr = String(e.message || e); ok = false; }
  $("wviz-amt-err").textContent = amtErr;
  sendBtn.disabled = !ok;
}
acctInput.addEventListener("input", validatePegout);
amtInput.addEventListener("input", validatePegout);

sendBtn.addEventListener("click", async () => {
  if (!userAddress) { tonConnectUI.openModal(); return; }
  const acct = acctInput.value.trim();
  let amountBaseUnits;
  try { amountBaseUnits = wvizToBaseUnits(amtInput.value, CONFIG.wviz.decimals); }
  catch (e) { $("wviz-amt-err").textContent = String(e.message || e); return; }
  sendBtn.disabled = true; sendBtn.textContent = "Preparing…";
  try {
    const jw = await walletAddressOf(userAddress); // sender's own wVIZ jetton wallet
    const body = buildPegoutBody(
      { beginCell, Address },
      {
        amountBaseUnits,
        destinationOwner: CONFIG.wviz.multisigOwner,
        responseAddress: userAddress,
        forwardTonAmount: toNano(CONFIG.gas.forwardTonAmount),
        vizRecipient: acct,
      },
    );
    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{ address: jw.toString(), amount: toNano(CONFIG.gas.messageValue).toString(), payload: body.toBoc().toString("base64") }],
    });
    showToast("Peg-out sent — VIZ arrives shortly");
    sendBtn.textContent = "Return wVIZ";
  } catch (e) {
    const msg = /reject|cancel/i.test(String(e)) ? "Transaction cancelled" : "Could not send — try again";
    showToast(msg);
    sendBtn.textContent = "Return wVIZ";
  } finally { validatePegout(); }
});

/* ---------- Peg-in helper + balance ---------- */
let firstTimeSurcharge = true;
let userBalanceBaseUnits = null;

function baseUnitsToDecimal(n, decimals) {
  const d = 10n ** BigInt(decimals);
  const whole = n / d;
  const frac = n % d;
  if (frac === 0n) return String(whole);
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

$("wviz-bal").addEventListener("click", () => {
  if (userBalanceBaseUnits === null) return;
  amtInput.value = baseUnitsToDecimal(userBalanceBaseUnits, CONFIG.wviz.decimals);
  validatePegout();
  amtInput.focus();
});

async function onWalletChange() {
  const memoEl = $("pegin-memo"), copyEl = $("pegin-memo-copy"), balEl = $("wviz-bal");
  if (!userAddress) {
    memoEl.textContent = "Connect your TON wallet to fill this in";
    copyEl.classList.add("hidden");
    balEl.classList.add("hidden");
    userBalanceBaseUnits = null;
    firstTimeSurcharge = true;
    updatePegInFee();
    return;
  }
  memoEl.textContent = userAddress;
  copyEl.setAttribute("data-copy", userAddress);
  copyEl.classList.remove("hidden");
  try {
    const jw = await walletAddressOf(userAddress);
    // Deployment check via plain REST — authoritative, independent of get-method availability.
    // Treat a non-2xx (429/5xx) as a retryable failure so we don't mistake a rate-limit for
    // an undeployed wallet and wrongly show the activation surcharge.
    const info = await withRetry(async () => {
      const r = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(jw.toString())}`);
      if (!r.ok) throw new Error(`toncenter ${r.status}`);
      return r.json();
    });
    const active = info?.result?.state === "active";
    firstTimeSurcharge = !active;
    if (active) {
      // Balance fetch is best-effort; firstTimeSurcharge is already correctly set above
      try {
        const res = await withRetry(() => ton.runMethod(jw, "get_wallet_data", []));
        userBalanceBaseUnits = res.stack.readBigNumber();
        const display = (Number(userBalanceBaseUnits) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
        balEl.textContent = `Balance: ${display} wVIZ`;
        balEl.classList.remove("hidden");
      } catch (_) { balEl.classList.add("hidden"); userBalanceBaseUnits = null; }
    } else {
      balEl.classList.add("hidden");
      userBalanceBaseUnits = null;
    }
  } catch (_) {
    firstTimeSurcharge = true;
    balEl.classList.add("hidden");
    userBalanceBaseUnits = null;
  }
  updatePegInFee();
}

function fmtViz(milli) { return (Number(milli) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 }); }

function updatePegInFee() {
  const raw = $("pegin-amt").value.trim();
  const feeEl = $("pegin-fee"), netEl = $("pegin-net"), ftEl = $("pegin-firsttime");
  ftEl.textContent = firstTimeSurcharge
    ? "Includes a one-time 10 VIZ activation surcharge (first peg-in to this TON wallet)."
    : "";
  if (!/^\d+(\.\d+)?$/.test(raw)) { feeEl.textContent = "—"; netEl.textContent = "—"; return; }
  const grossMilli = BigInt(Math.round(parseFloat(raw) * 1000));
  const { total } = computePegInFee({
    grossMilliViz: grossMilli,
    floorMilliViz: CONFIG.fees.floorMilliViz,
    bps: CONFIG.fees.bps,
    activationSurchargeMilliViz: CONFIG.fees.activationSurchargeMilliViz,
    walletDeployed: !firstTimeSurcharge,
  });
  const net = grossMilli - total;
  feeEl.textContent = fmtViz(total) + " VIZ";
  netEl.textContent = net > CONFIG.fees.mintGasFloorMilliViz ? fmtViz(net) + " wVIZ" : "too small — would be refunded";
}

$("pegin-amt").addEventListener("input", updatePegInFee);

/* ---------- React to connect/disconnect ---------- */
tonConnectUI.onStatusChange((w) => {
  userAddress = w ? Address.parse(w.account.address).toString({ bounceable: false }) : null;
  validatePegout();
  onWalletChange();
});

/* ---------- Live status (all sources fail soft) ---------- */
function setItem(id, label, value) {
  const el = $(id);
  el.textContent = "";
  el.append(label + " ");
  const b = document.createElement("b");
  b.textContent = value;
  el.appendChild(b);
}
function hideItem(id) { $(id).classList.add("hidden"); }

async function loadSupply() {
  try {
    const res = await withRetry(() => ton.runMethod(Address.parse(CONFIG.wviz.minter), "get_jetton_data", []));
    const totalSupply = res.stack.readBigNumber(); // base units
    setItem("st-supply", "wVIZ circulating", (Number(totalSupply) / 1000).toLocaleString() + " wVIZ");
    return Number(totalSupply) / 1000;
  } catch (_) { hideItem("st-supply"); return null; }
}

async function loadVizLocked() {
  try {
    const r = await fetch(CONFIG.rpc.viz, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: ["database_api", "get_accounts", [[CONFIG.pegIn.vizAccount]]] }),
    });
    const j = await r.json();
    const acct = j?.result?.[0] ?? j?.result?.accounts?.[0];
    const bal = parseFloat(String(acct?.balance ?? "").replace(/[^\d.]/g, ""));
    if (!isFinite(bal)) throw new Error("no balance");
    setItem("st-reserve", "VIZ locked", bal.toLocaleString() + " VIZ");
    return bal;
  } catch (_) { hideItem("st-reserve"); return null; }
}

async function loadHealth() {
  try {
    const r = await fetch(CONFIG.rpc.health, { mode: "cors" });
    const h = await r.json();
    if (h.paused) {
      const span = document.createElement("span");
      span.className = "warn";
      span.textContent = "⏸ Paused — new deposits discouraged";
      const el = $("st-health");
      el.textContent = "";
      el.appendChild(span);
    }
    else setItem("st-health", "Operators", `${h.registered}/${h.expected} online`);
  } catch (_) { hideItem("st-health"); }
}

selectTab("out");
validatePegout();
loadSupply(); loadVizLocked(); loadHealth();
