#!/usr/bin/env node
/**
 * ONE-OFF operator tool — refund a stranded no-memo peg-in from a gateway backing
 * account (2-of-N VIZ multisig) back to its original sender.
 *
 * Context: a VIZ transfer to gram.gate with an EMPTY memo is dropped by the watcher
 * (no mint destination) and is NOT on the auto-refund path, so it strands in the
 * backing account as over-backing. This tool builds + co-signs + broadcasts the
 * manual VIZ multisig transfer to return it. It reuses the gateway's VERIFIED release
 * primitives (deterministic tx bytes, key-recovery signature selection) from
 * packages/viz-watcher/dist/vizSign.js — no bespoke crypto.
 *
 * It does NOT touch the gateway store, coordinator, or any peg-in state.
 *
 * ── Flow (two operators, separate boxes) ─────────────────────────────────────────
 *   1. One operator runs `build`  → writes refund-proposal.json (deterministic tx
 *      skeleton: TaPoS + transfer + a long expiration) and shares that file verbatim.
 *   2. EACH of two operators runs `sign <proposal>` on their own box (needs their
 *      gram.gate active-authority WIF in VIZ_SIGNING_WIF) → prints one signature hex.
 *      Signing is offline (no RPC); both sign the SAME bytes from the shared file.
 *   3. One operator runs `broadcast <proposal> <sig1> <sig2>` → picks the minimal
 *      in-authority signature subset and broadcasts. DRY-RUN unless APPLY=1.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────
 *   node tools/refund-no-memo.cjs build
 *   VIZ_SIGNING_WIF=5... node tools/refund-no-memo.cjs sign refund-proposal.json
 *   APPLY=1 node tools/refund-no-memo.cjs broadcast refund-proposal.json <sigA> <sigB>
 *
 * ── Env ──────────────────────────────────────────────────────────────────────────
 *   VIZ_NODE_URL     node HTTP URL           (default https://node.viz.cx)
 *   FROM             backing account         (default gram.gate)
 *   TO               refund recipient        (default id)
 *   AMOUNT_VIZ       amount, VIZ             (default 2000.000)
 *   MEMO             transfer memo           (default "refund: no-memo peg-in <TX>")
 *   EXPIRE_MIN       tx expiration, minutes  (default 45; keep < VIZ's ~1h max)
 *   PROPOSAL_OUT     build output path       (default refund-proposal.json)
 *   VIZ_SIGNING_WIF  operator active WIF     (sign only; source from the keystore)
 *   APPLY=1          actually broadcast      (broadcast is DRY-RUN without it)
 */
"use strict";

const fs = require("fs");
const viz = require("viz-js-lib");
const {
  buildReleaseTx,
  releaseTxId,
  signRelease,
  recoverReleaseSigner,
  selectAuthoritySignatures,
} = require("../packages/viz-watcher/dist/vizSign.js");
const { vizToMilli } = require("../packages/viz-watcher/dist/vizChain.js");

const NODE_URL = process.env.VIZ_NODE_URL || "https://node.viz.cx";
const FROM = process.env.FROM || "gram.gate";
const TO = process.env.TO || "id";
const AMOUNT_VIZ = process.env.AMOUNT_VIZ || "2000.000";
const STRANDED_TX = "3FB76DC9A71731B98C408D934434A471298CAFD1";
const MEMO = process.env.MEMO !== undefined ? process.env.MEMO : `refund: no-memo peg-in ${STRANDED_TX}`;
const EXPIRE_MIN = Number(process.env.EXPIRE_MIN || "45");
const PROPOSAL_OUT = process.env.PROPOSAL_OUT || "refund-proposal.json";
const APPLY = process.env.APPLY === "1";

viz.config.set("websocket", NODE_URL);

function call(fn) {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));
}
function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
const amountString = () => `${parseFloat(AMOUNT_VIZ).toFixed(3)} VIZ`;

function loadProposal(pathOrJson) {
  if (!pathOrJson) die("missing <proposal> (path to refund-proposal.json)");
  const raw = fs.existsSync(pathOrJson) ? fs.readFileSync(pathOrJson, "utf8") : pathOrJson;
  const p = JSON.parse(raw);
  for (const k of ["refBlockNum", "refBlockPrefix", "expiration", "from", "to", "amount"]) {
    if (p[k] === undefined || p[k] === null) die(`proposal missing field "${k}"`);
  }
  if (p.memo === undefined) p.memo = "";
  return p;
}
function printProposalSummary(p) {
  console.log("  transfer :", p.from, "->", p.to, p.amount);
  console.log("  memo     :", JSON.stringify(p.memo));
  console.log("  expires  :", p.expiration, "UTC");
  console.log("  TaPoS    : refBlockNum", p.refBlockNum, "refBlockPrefix", p.refBlockPrefix);
  console.log("  txid     :", releaseTxId(p));
}

async function cmdBuild() {
  const gp = await call((cb) => viz.api.getDynamicGlobalProperties(cb));
  const refBlockNum = gp.head_block_number & 0xffff;
  const refBlockPrefix = Buffer.from(gp.head_block_id, "hex").readUInt32LE(4);
  // Long expiration (vs the gateway's 60s) so two operators on separate boxes can co-sign.
  const expiration = new Date(Date.now() + EXPIRE_MIN * 60_000).toISOString().slice(0, 19);
  const proposal = { refBlockNum, refBlockPrefix, expiration, from: FROM, to: TO, amount: amountString(), memo: MEMO };

  // Sanity: the source account exists and holds enough to refund.
  const [acct] = (await call((cb) => viz.api.getAccounts([FROM], cb))) || [];
  if (!acct) die(`source account "${FROM}" not found on ${NODE_URL}`);
  console.log(`\n[build] source ${FROM} balance = ${acct.balance}`);
  if (vizToMilli(acct.balance) < vizToMilli(amountString()))
    console.warn(`WARNING: balance ${acct.balance} < refund ${amountString()} — broadcast will fail.`);
  const th = acct.active_authority?.weight_threshold;
  console.log(`[build] ${FROM} active authority weight_threshold = ${th} (needs ${th} distinct in-authority signatures)`);

  fs.writeFileSync(PROPOSAL_OUT, JSON.stringify(proposal, null, 2) + "\n");
  console.log(`\n[build] wrote ${PROPOSAL_OUT} — share this file verbatim with the co-signer.`);
  printProposalSummary(proposal);
  console.log(`\nNext: each operator runs  VIZ_SIGNING_WIF=<wif> node tools/refund-no-memo.cjs sign ${PROPOSAL_OUT}`);
  console.log(`(all signatures must be produced before expiration: ${proposal.expiration} UTC)`);
}

function cmdSign(proposalArg) {
  const wif = process.env.VIZ_SIGNING_WIF;
  if (!wif) die("VIZ_SIGNING_WIF not set — source this operator's gram.gate active WIF from the keystore");
  const p = loadProposal(proposalArg);
  const sig = signRelease(p, wif);
  const key = recoverReleaseSigner(p, sig); // offline recovery, so the operator can confirm which key signed
  console.log("\n[sign] signing bytes for:");
  printProposalSummary(p);
  console.log("\n[sign] signer public key :", key);
  console.log("[sign] signature (hex)   :\n" + sig);
  console.log("\nSend this signature to whoever runs `broadcast`. Confirm the key above is one of the gram.gate active keys.");
}

async function cmdBroadcast(proposalArg, sigs) {
  if (sigs.length < 1) die("provide the collected signatures: broadcast <proposal> <sig1> <sig2> ...");
  const p = loadProposal(proposalArg);
  const [acct] = (await call((cb) => viz.api.getAccounts([p.from], cb))) || [];
  if (!acct?.active_authority) die(`no active authority for ${p.from}`);
  const authority = { weight_threshold: acct.active_authority.weight_threshold, key_auths: acct.active_authority.key_auths };

  console.log("\n[broadcast] proposal:");
  printProposalSummary(p);
  console.log(`\n[broadcast] ${p.from} balance = ${acct.balance}; authority threshold = ${authority.weight_threshold}`);
  console.log("[broadcast] attributing collected signatures to keys:");
  for (const s of sigs) {
    let key;
    try { key = recoverReleaseSigner(p, s); } catch { key = "<unrecoverable>"; }
    const w = authority.key_auths.find(([k]) => k === key);
    console.log(`   ${key}  ${w ? `(weight ${w[1]}, in authority)` : "(NOT in authority — will be ignored)"}`);
  }

  // Fail-closed: throws if the in-authority subset can't reach threshold.
  const chosen = selectAuthoritySignatures(p, sigs, authority);
  console.log(`\n[broadcast] selected ${chosen.length} in-authority signature(s) — threshold satisfied.`);

  const tx = buildReleaseTx(p);
  tx.signatures = chosen;
  const txid = releaseTxId(p);

  if (!APPLY) {
    console.log(`\n[DRY-RUN] APPLY=1 not set — NOT broadcasting. Would broadcast txid ${txid}.`);
    console.log("[DRY-RUN] final signed tx:\n" + JSON.stringify(tx, null, 2));
    return;
  }

  console.log(`\n[broadcast] APPLY=1 — broadcasting txid ${txid} ...`);
  let broadcastErr = "";
  try {
    await call((cb) => viz.api.broadcastTransaction(tx, cb));
  } catch (err) {
    // Async broadcast can still land even if the HTTP call errors (proxy hiccup / already-in-pool).
    broadcastErr = String(err && err.message ? err.message : err);
    console.warn(`[broadcast] broadcast call errored (${broadcastErr}); polling by txid to decide...`);
  }
  // Poll the deterministic id (VIZ transfers are not nonce-deduped, so confirm by exact id).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const seen = await call((cb) => viz.api.getTransaction(txid, cb));
      if (seen) { console.log(`\n✅ CONFIRMED on-chain: ${txid}`); return; }
    } catch { /* unknown id yet — keep polling */ }
    process.stdout.write(".");
  }
  die(`\nnot confirmed after polling${broadcastErr ? ` (last broadcast error: ${broadcastErr})` : ""}. Re-check the explorer before re-running (do not double-broadcast a NEW proposal for the same refund).`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "build": return cmdBuild();
    case "sign": return cmdSign(rest[0]);
    case "broadcast": return cmdBroadcast(rest[0], rest.slice(1).filter(Boolean));
    default:
      console.log("usage: refund-no-memo.cjs <build | sign <proposal> | broadcast <proposal> <sig...>>");
      console.log("see the header of this file for the full flow. broadcast is DRY-RUN unless APPLY=1.");
      process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => die(e && e.stack ? e.stack : String(e)));
