#!/usr/bin/env node
/**
 * Security proof for the WebVIZWallet peg-in deep-link builder (site/app.js
 * updatePegInDeeplink). Feeds XSS / injection payloads through the EXACT logic
 * and asserts that every produced href is inert:
 *   - scheme stays https (no javascript:/data: takeover)
 *   - no unencoded HTML/quote/ampersand breakout in any query value
 *   - non-numeric amounts are dropped (never reach the URL)
 *
 * Run: node tools/deeplink-xss-proof.cjs
 */

const WALLET_TRANSFER_URL = "https://wallet.viz.world/assets/transfer/";
const GATEWAY_ACCOUNT = "gram.gate";

// Faithful copy of site/app.js updatePegInDeeplink() URL construction.
function buildDeeplink({ userAddress, amountRaw }) {
  if (!userAddress) return null; // button hidden — no wallet connected
  const raw = String(amountRaw ?? "").trim();
  const params = [
    "account=" + encodeURIComponent(GATEWAY_ACCOUNT),
    "memo=" + encodeURIComponent(userAddress),
  ];
  if (/^\d+(\.\d+)?$/.test(raw)) {
    params.splice(1, 0, "amount=" + encodeURIComponent(String(parseFloat(raw))));
  }
  return WALLET_TRANSFER_URL + "?" + params.join("&");
}

// Characters that, if they appeared RAW in the produced href, would signal a
// breakout (HTML tag, attribute, or a new query param).
const DANGEROUS_RAW = ["<", ">", '"', "&&", " ", "\n", "\t"];

const AMOUNT_PAYLOADS = [
  `"><script>alert(1)</script>`,
  `javascript:alert(1)`,
  `1&memo=evil`,
  `1"><img src=x onerror=alert(1)>`,
  `5000`,      // legit control — should pass
  `10.5`,      // legit control — should pass
  `0x1F4`,
  `1e3`,
  `  42  `,
];

const MEMO_PAYLOADS = [
  `UQBza2dHCsStHkqDmRASr6_boRTj415z6kKcGWfCeKVTPhtK`, // legit control
  `javascript:alert(document.domain)`,
  `"><svg onload=alert(1)>`,
  `x&account=attacker.gate&memo=y`,
  `' onmouseover='alert(1)`,
  `#/../../evil?x=<script>alert(1)</script>`,
];

let failures = 0;
function check(label, href, { amountShouldAppear } = {}) {
  const problems = [];
  if (href === null) { console.log(`  (button hidden — no wallet) ${label}`); return; }

  // 1. scheme must stay https
  if (!href.startsWith("https://wallet.viz.world/assets/transfer/?")) {
    problems.push("BASE/SCHEME ALTERED");
  }
  // 2. no raw dangerous chars anywhere in the href
  for (const ch of DANGEROUS_RAW) {
    if (href.includes(ch)) problems.push(`RAW '${ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch}' present`);
  }
  // 3. exactly the params we intend — no injected extras
  const query = href.split("?")[1] ?? "";
  const keys = query.split("&").map((kv) => kv.split("=")[0]);
  const allowed = new Set(["account", "amount", "memo"]);
  for (const k of keys) if (!allowed.has(k)) problems.push(`unexpected param '${k}'`);
  if (keys.filter((k) => k === "account").length !== 1) problems.push("account count != 1");
  // 4. amount presence matches the gate
  if (amountShouldAppear !== undefined) {
    const hasAmount = keys.includes("amount");
    if (hasAmount !== amountShouldAppear) problems.push(`amount ${hasAmount ? "leaked" : "missing"}`);
  }

  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`        → ${href}`);
  if (!ok) console.log(`        !! ${problems.join("; ")}`);
}

const LEGIT_MEMO = "UQBza2dHCsStHkqDmRASr6_boRTj415z6kKcGWfCeKVTPhtK";

console.log("\n=== amount field payloads (regex-gated + encoded) ===");
for (const p of AMOUNT_PAYLOADS) {
  const shouldAppear = /^\d+(\.\d+)?$/.test(p.trim());
  check(`amount=${JSON.stringify(p)}`, buildDeeplink({ userAddress: LEGIT_MEMO, amountRaw: p }), { amountShouldAppear: shouldAppear });
}

console.log("\n=== memo payloads (encodeURIComponent) ===");
for (const p of MEMO_PAYLOADS) {
  check(`memo=${JSON.stringify(p)}`, buildDeeplink({ userAddress: p, amountRaw: "5000" }));
}

console.log(`\n${failures === 0 ? "ALL SAFE ✓ — every href is inert" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
