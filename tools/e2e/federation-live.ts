// tools/e2e/federation-live.ts — Phase A live happy-path proof for N-of-M federation.
//
// Proves a real 2-of-3 VIZ peg-out through independent operator processes:
//   Phase 1 (solo, existing TON path): lock VIZ → mint wVIZ on TON testnet.
//   Phase 2 (federation, 3 signers): burn wVIZ → coordinator fans out to 3 signers,
//     collects 2 VIZ partial signatures, broadcasts a VIZ release. Since tester4's
//     active authority is now 2-of-3, a successful release proves the multi-sig tx
//     carried ≥2 valid operator signatures.
//
// Design notes:
//   - TON peg-in signing (Phase 1) uses the solo signer (op-1, with the TON mnemonic).
//     TON peg-out is still 1-of-1 on-chain (Phase B work); that path is not proven here.
//   - VIZ peg-out signing (Phase 2) uses all 3 signers with distinct VIZ WIFs.
//     Signers validate the TON burn via their own TON read-only endpoint (no mnemonic).
//   - The proof assertion is the VIZ balance delta: the VIZ chain rejects a release
//     unless ≥2 of the 3 registered active keys signed the tx, so a credited balance
//     IS proof of 2-of-3 signature collection and acceptance.
//
// Run: npm run e2e:federation:live
// Env: .env.e2e (all base + federation vars)

import { loadConfig, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { loadFederationConfig, buildFederationRunEnv } from "./federation-config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { assertDelta } from "./deltas";
import { pollUntil } from "./poll";
import { launchStack, launchFederationStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { submitBurn, tonWvizBalance } from "./ton";

const PEG_IN_TIMEOUT_MS  = 8 * 60_000;
const PEG_OUT_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 5_000;

async function main() {
  const baseCfg = loadE2eConfig(process.env, "gram");
  const fedCfg  = loadFederationConfig(process.env);
  const baseEnv = buildRunEnv(baseCfg);
  const logDir  = `tools/e2e/logs/fed-live-${baseCfg.runId}`;

  // Merge base env so loadConfig() picks up shared vars (fees, etc.).
  Object.assign(process.env, baseEnv);
  const fees = loadConfig().fees;

  // Solo env: op-1 only, 1-of-1 (for the TON peg-in where only op-1 has the mnemonic).
  const soloEnv: Record<string, string> = {
    ...baseEnv,
    FEDERATION_N: "1",
    FEDERATION_THRESHOLD: "1",
    OPERATOR_ID: fedCfg.operators[0]!.id,
    VIZ_SIGNING_WIF: fedCfg.operators[0]!.wif,
    SIGNER_LISTEN: "127.0.0.1:8091",
    SIGNER_ENDPOINTS: "http://127.0.0.1:8091",
    COORDINATOR_LISTEN: "127.0.0.1:8080",
    COORDINATOR_URL: "http://127.0.0.1:8080",
  };

  // Federation env: 3 signers, threshold 2 (for the VIZ peg-out).
  const { signerSpecs, coordinatorEnv } = buildFederationRunEnv(fedCfg, {
    ...baseEnv,
    COORDINATOR_LISTEN: "127.0.0.1:8080",
    COORDINATOR_URL: "http://127.0.0.1:8080",
  });

  // ── Preflight ─────────────────────────────────────────────────────────────
  const vizBal = await vizBalanceMilliViz(baseCfg.viz.nodeUrl, baseCfg.viz.testAccount);
  if (vizBal < baseCfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${baseCfg.viz.testAccount} — have ${vizBal} mVIZ, need ${baseCfg.viz.minBalanceMilliViz}`);
  }

  const tonOwner  = baseCfg.gram.burnOwner;
  const gross     = uniqueGrossMilliViz(20_000n, baseCfg.runId);
  const net       = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);
  const recvAcct  = baseCfg.viz.recipient;

  console.log(`[fed-live] run=${baseCfg.runId} gross=${gross} net=${net}`);
  console.log(`[fed-live] federation: ${fedCfg.threshold}-of-${fedCfg.n} (${fedCfg.operators.map(o => o.id).join(",")})`);

  // ── PHASE 1: solo peg-in → get wVIZ on TON testnet ────────────────────────

  console.log("\n[fed-live] Phase 1: solo peg-in (1-of-1 signer, TON path)...");

  const wvizBefore = await tonWvizBalance(baseCfg, tonOwner);
  const recvBefore = await vizBalanceMilliViz(baseCfg.viz.nodeUrl, recvAcct);

  console.log(`[fed-live] wVIZ before: ${wvizBefore}`);

  const soloStack = await launchStack(
    ["viz-watcher", "ton-watcher", "signer", "coordinator", "dispatcher"],
    soloEnv,
    `${logDir}-phase1`,
  );

  let wvizAfter: bigint;
  try {
    const memo   = `ton:${tonOwner}`;
    const lockTx = await submitLock(baseCfg, gross, memo);
    console.log(`[fed-live] peg-in lock: ${lockTx}`);

    wvizAfter = await pollUntil(
      async () => {
        const b = await tonWvizBalance(baseCfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: PEG_IN_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in mint (solo)" },
    );
    assertDelta("ton-wviz (solo peg-in)", wvizBefore, wvizAfter, net);
    console.log(`[fed-live] Phase 1 DONE — wVIZ minted: +${net} (balance=${wvizAfter})`);
  } finally {
    await soloStack.stop();
  }

  // Brief pause between phases.
  await new Promise(r => setTimeout(r, 2000));

  // ── PHASE 2: federation peg-out → 2-of-3 VIZ release ────────────────────

  console.log("\n[fed-live] Phase 2: federation peg-out (2-of-3 VIZ signing)...");
  console.log(`[fed-live] burning ${net} wVIZ → releasing VIZ to ${recvAcct}`);

  const fedStack = await launchFederationStack(signerSpecs, coordinatorEnv, `${logDir}-phase2`);

  // Also spin up the watchers + dispatcher with shared env (they connect to the
  // federation coordinator at http://127.0.0.1:8080).
  const watcherEnv: Record<string, string> = {
    ...baseEnv,
    FEDERATION_N: String(fedCfg.n),
    FEDERATION_THRESHOLD: String(fedCfg.threshold),
    COORDINATOR_URL: "http://127.0.0.1:8080",
  };
  const watcherStack = await launchStack(
    ["viz-watcher", "ton-watcher", "dispatcher"],
    watcherEnv,
    `${logDir}-phase2`,
  );

  try {
    // Burn the wVIZ minted in phase 1.
    await submitBurn(baseCfg, net, recvAcct);
    console.log(`[fed-live] wVIZ burn submitted`);

    const recvAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(baseCfg.viz.nodeUrl, recvAcct);
        return b - recvBefore === net ? b : null;
      },
      { timeoutMs: PEG_OUT_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-out release (2-of-3)" },
    );
    assertDelta("viz-release (2-of-3)", recvBefore, recvAfter, net);

    console.log(`\n[fed-live] ✓ PHASE A LIVE PROOF COMPLETE`);
    console.log(`[fed-live] ✓ VIZ released: +${net} mVIZ to ${recvAcct}`);
    console.log(`[fed-live] ✓ tester4 is 2-of-3 on-chain → successful release proves`);
    console.log(`[fed-live]   the coordinator collected ≥2 valid operator signatures`);
    console.log(`[fed-live]   from ${fedCfg.n} independent signer processes.`);
  } finally {
    await watcherStack.stop();
    await fedStack.stopAll();
  }
}

main().catch((err) => {
  console.error(`[fed-live] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
