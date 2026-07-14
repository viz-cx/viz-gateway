#!/usr/bin/env node
/**
 * Vanity address search for the wVIZ Jetton minter.
 *
 * The standard governed minter's load_data reads exactly
 *   total_supply:Coins admin:MsgAddress content:^Cell wallet_code:^Cell
 * and does NOT end_parse, so appending a salt of trailing bits to the data cell
 * is ignored by the contract on load, and dropped on its first save_data — but
 * the address is fixed at deploy, so a chosen friendly-form suffix sticks forever.
 *
 * We brute-force the salt until the bounceable EQ… form ends with one of the
 * target suffixes. The winning data cell is written to a .data.boc that
 * deploy:minter consumes via JETTON_MINTER_DATA_BOC.
 *
 * Env:
 *   JETTON_MINTER_CODE_BOC, JETTON_WALLET_CODE_BOC, JETTON_INITIAL_ADMIN,
 *   WVIZ_NAME/SYMBOL/DECIMALS/DESCRIPTION/IMAGE  (same as deploy:minter)
 *   VANITY_SUFFIXES  comma list, default "_VIZ,_viz,wVIZ"
 *   VANITY_OUT       output data boc, default contracts/ton/boc/minter-wviz-mainnet.data.boc
 *   VANITY_MAX       max tries, default 200_000_000
 *   VANITY_COUNT     collect this many candidates then print+exit (no boc written
 *                    when >1 — pick a salt, re-run with VANITY_SALT to emit it)
 *   VANITY_SALT      skip search: emit the data boc for this exact salt
 */
const { readFileSync, writeFileSync } = require("node:fs");
const { Address, beginCell, Cell, contractAddress } = require("@ton/core");
const { buildWvizContent } = require("../contracts/ton/dist/metadata.js");

function env(k, d) {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
}
function loadCode(path) {
  const cells = Cell.fromBoc(readFileSync(path));
  if (!cells[0]) throw new Error(`no cell in ${path}`);
  return cells[0];
}

const code = loadCode(env("JETTON_MINTER_CODE_BOC"));
const walletCode = loadCode(env("JETTON_WALLET_CODE_BOC"));
const admin = Address.parse(env("JETTON_INITIAL_ADMIN"));
const content = buildWvizContent({
  name: env("WVIZ_NAME", "Wrapped VIZ"),
  symbol: env("WVIZ_SYMBOL", "wVIZ"),
  decimals: env("WVIZ_DECIMALS", "3"),
  description: env("WVIZ_DESCRIPTION", ""),
  image: env("WVIZ_IMAGE", ""),
});
const suffixes = env("VANITY_SUFFIXES", "_VIZ,_viz,wVIZ").split(",").map((s) => s.trim()).filter(Boolean);
// Reject any address containing one of these chars anywhere (e.g. "-").
const forbid = [...env("VANITY_FORBID", "")];
// Reject these chars in the BODY (the address minus the matched suffix), so the
// separator can appear in the suffix but nowhere else — e.g. VANITY_FORBID_BODY="_-"
// with suffixes "_VIZ,-VIZ,_viz,-viz" => the sep before VIZ is the only _ or -.
const forbidBody = [...env("VANITY_FORBID_BODY", "")];
const outPath = env("VANITY_OUT", "contracts/ton/boc/minter-wviz-mainnet.data.boc");
const maxTries = Number(env("VANITY_MAX", "200000000"));

// Build the minter data cell for a given salt (32-bit trailing nonce).
function dataForSalt(salt) {
  return beginCell()
    .storeCoins(0) // total_supply
    .storeAddress(admin)
    .storeRef(content)
    .storeRef(walletCode)
    .storeUint(salt, 32) // salt: unused trailing bits (contract ignores; drops on save)
    .endCell();
}

// Emit-only mode: write the data boc for an already-chosen salt.
const fixedSalt = process.env.VANITY_SALT;
if (fixedSalt !== undefined && fixedSalt !== "") {
  const salt = Number(fixedSalt);
  const data = dataForSalt(salt);
  const addr = contractAddress(0, { code, data }).toString();
  writeFileSync(outPath, data.toBoc());
  console.log(`[vanity] emitted salt=${salt} -> ${addr}`);
  console.log(`[vanity] data boc: ${outPath}`);
  process.exit(0);
}

const wantCount = Number(env("VANITY_COUNT", "1"));
console.log(`[vanity] targets: ${suffixes.map((s) => "EQ…" + s).join("  ")}  (collect ${wantCount})`);
console.log(`[vanity] admin=${admin.toString()}  max=${maxTries.toLocaleString()}`);
const started = process.hrtime.bigint();
const hits = [];
for (let salt = 0; salt < maxTries && hits.length < wantCount; salt++) {
  const data = dataForSalt(salt);
  const addr = contractAddress(0, { code, data });
  const s = addr.toString(); // bounceable, urlSafe, mainnet => EQ…
  const suf = suffixes.find((x) => s.endsWith(x));
  const bodyOk = suf !== undefined && !forbidBody.some((c) => s.slice(0, -suf.length).includes(c));
  if (suf !== undefined && bodyOk && !forbid.some((c) => s.includes(c))) {
    hits.push({ salt, addr: s, data });
    console.log(`[vanity]  ${addr.toString()}   salt=${salt}`);
  }
  if (salt % 500000 === 0 && salt > 0) {
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    console.log(`[vanity] ${salt.toLocaleString()} tried  ${(salt / secs / 1000).toFixed(1)}k/s  ${secs.toFixed(0)}s  hits=${hits.length}`);
  }
}
if (hits.length === 0) {
  console.error(`[vanity] no match in ${maxTries.toLocaleString()} tries`);
  process.exit(1);
}
const secs = Number(process.hrtime.bigint() - started) / 1e9;
if (hits.length === 1) {
  writeFileSync(outPath, hits[0].data.toBoc());
  console.log(`\n[vanity] FOUND (${secs.toFixed(1)}s)  ${hits[0].addr}  salt=${hits[0].salt}`);
  console.log(`[vanity] data boc: ${outPath} — set JETTON_MINTER_DATA_BOC and re-run deploy:minter`);
} else {
  console.log(`\n[vanity] ${hits.length} candidates (${secs.toFixed(1)}s). Pick one, then:`);
  console.log(`[vanity]   VANITY_SALT=<salt> node tools/vanity-minter-search.cjs   # writes ${outPath}`);
}
