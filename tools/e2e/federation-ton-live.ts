// tools/e2e/federation-ton-live.ts — LIVE 3-of-5 TON peg-in proof (RUNBOOK §9b).
//
// Proves the Phase B trust boundary on TON testnet: FIVE independent operator
// wallets, a KEYLESS coordinator, and a wVIZ mint that only lands once THREE
// distinct operators approve on-chain. Each signer approves from its OWN TON
// wallet (FED_OP<i>_GRAM_MNEMONIC) — the coordinator holds no TON key.
//
// This is the live counterpart of tools/ton-onchain-approval-spike.cjs (which
// proves the same threshold gating offline against the vendored contracts).
//
// Exit criteria (§9b), each asserted here:
//   1. threshold mint      — 3 independent approvals → wVIZ +net exactly.
//   2. under-threshold     — kill N-T+1 signers → order never executes, no mint.
//   3. crash-window        — kill coordinator mid-approval → SAME order completes,
//                            no double-mint (multisig nextOrderSeqno is the oracle).
//   4. rotation            — drop an operator → its approve is rejected on-chain.
//                            (Live rotation wiring: see step 4 below; gated on
//                            FED_ROTATION_MODE until the rotation ceremony is run.)
//
// SAFETY: submits real testnet VIZ locks and mints real testnet wVIZ.
//
// Prereqs (RUNBOOK §9b): a fresh 3-of-5 multisig deployed with the 5 operator
// wallets as signers, wVIZ minter admin handed to it, and .env.e2e carrying
// FED_N=5, FED_THRESHOLD=3, FED_OP{1..5}_ID/WIF/TON_MNEMONIC + the shared
// E2E_GRAM_MULTISIG_ADDRESS / E2E_GRAM_JETTON_MINTER_ADDRESS.
//
// Run: npm run e2e:federation:ton:live
import { createStore, loadConfig, type OutboxRecord, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { loadFederationConfig, buildFederationRunEnv } from "./federation-config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { pollUntil } from "./poll";
import { launchStack, launchFederationStack, type FederationStack, type LaunchedStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { tonWvizBalance, nextOrderInfo, nextOrderSeqno, orderExists } from "./ton";
import { proveRotationLive } from "./ton-rotation";

// Live testnet end-to-end mint latency (VIZ irreversibility lag + 3 SEQUENTIAL
// on-chain TON approvals + toncenter 504 retries) routinely exceeds 4 min, so the
// settle/recovery windows are generous. A too-tight window fails a mint that is
// in fact landing correctly (observed: net credited at ~5 min).
const FIND_ROW_TIMEOUT_MS = 4 * 60_000;
const ORDER_LANDS_TIMEOUT_MS = 8 * 60_000;
const MINT_SETTLE_TIMEOUT_MS = 10 * 60_000;
const RECOVERY_TIMEOUT_MS = 10 * 60_000;
const UNDER_THRESHOLD_WAIT_MS = 5 * 60_000; // > max positive-mint latency, so a mint WOULD have landed
// Criterion 2 uses a SHORT delivery window (well under UNDER_THRESHOLD_WAIT_MS) so its
// under-threshold peg-in exhausts the window and goes REFUNDING — a terminal state —
// *within* the criterion. Otherwise the row stays QUEUED and, once criterion 3
// relaunches all signers, its half-approved order completes and mints late (observed:
// c2 minted during c3, doubling c3's delta). The wide DISPATCHER_WINDOW_MS that keeps
// c1/c3 from refunding a legitimately-landing mint is exactly what caused that, so c2
// opts out of it.
const UNDER_THRESHOLD_WINDOW_MS = 2 * 60_000;
const POLL_MS = 5_000;
// The dispatcher REFUNDS a PEG_IN whose delivery window elapses before threshold
// is met (packages/dispatcher/src/policy.ts). Its default is 3 min — shorter than
// the ~5-min live TON mint (3 sequential on-chain approvals + toncenter retries),
// so a correctly-landing mint would be refunded mid-flight. Widen it past the
// observed mint latency so the dispatcher rides out transient 504s instead.
const DISPATCHER_WINDOW_MS = 8 * 60_000;
// Per-step on-chain wait for the TON approver (order deploy / vote reflect). The 60s
// default is too tight for testnet; three sequential steps at this ceiling stay
// within DISPATCHER_WINDOW_MS on the happy path (each step typically ~30-90s).
const GRAM_APPROVE_MAX_WAIT_MS = 150_000;
// TON (nano) the proposer attaches per order. The mint action needs ~0.1 TON + gas;
// 0.3 TON covers it with margin while keeping the proposer's per-order drain low
// (surplus flows to the multisig, not back to the proposer), so a lightly-funded
// proposer can still cover the whole suite. Overrides the 1 TON default.
const GRAM_ORDER_VALUE_NANO = 300_000_000;

const WATCHERS = ["viz-watcher", "gram-watcher", "dispatcher"] as const;

async function main() {
  const cfg = loadE2eConfig(process.env, "gram");
  const fedCfg = loadFederationConfig(process.env);
  if (fedCfg.n < 5 || fedCfg.threshold < 3) {
    throw new Error(`§9b expects a 3-of-5 (or larger) federation; got ${fedCfg.threshold}-of-${fedCfg.n}`);
  }
  if (fedCfg.operators.some((o) => !o.gramMnemonic)) {
    throw new Error("every operator needs its OWN FED_OP<i>_GRAM_MNEMONIC for the live TON proof");
  }

  // Rotation-only: criteria 1-3 already proven+recorded on this multisig (RUNBOOK
  // §9b), so prove ONLY the destructive criterion 4 directly against the deployed
  // multisig — no federation stack, no VIZ preflight, no re-mints. Still gated on
  // FED_ROTATION_MODE=live inside proveRotation (unset → SKIPPED, exits non-fatally).
  if (process.env.FED_ROTATION_ONLY === "1") {
    console.log(`[fed-ton] run=${cfg.runId} ROTATION-ONLY (criteria 1-3 skipped; already proven)`);
    const rotated = await proveRotation(cfg, fedCfg);
    console.log(
      rotated
        ? `\n[fed-ton] ✓ §9b criterion 4 (rotation rejects old signers) PROVEN`
        : `[fed-ton]   set FED_ROTATION_MODE=live to run it`,
    );
    return;
  }

  const baseEnv = buildRunEnv(cfg);
  Object.assign(process.env, baseEnv);
  const fees = loadConfig().fees;
  const store = createStore(baseEnv.STORE_URL!);
  const logDir = `tools/e2e/logs/fed-ton-live-${cfg.runId}`;

  // The coordinator is KEYLESS on TON: strip any TON mnemonic from its env. It
  // designates the FIRST federation operator as proposer, so signerSpecs order
  // (op-1 first) puts the proposer's endpoint first in SIGNER_ENDPOINTS.
  const { signerSpecs, coordinatorEnv } = buildFederationRunEnv(fedCfg, {
    ...baseEnv,
    COORDINATOR_LISTEN: "127.0.0.1:8080",
    COORDINATOR_URL: "http://127.0.0.1:8080",
    // Each signer's TonApprover waits for its proposed order / approval to land
    // on-chain. Testnet inclusion + toncenter view lag exceed the 60s default
    // (observed: order did not appear within 60s), so widen it for the live run.
    GRAM_APPROVE_MAX_WAIT_MS: String(GRAM_APPROVE_MAX_WAIT_MS),
    // Lower per-order deployment value so a lightly-funded proposer covers the suite.
    GRAM_ORDER_VALUE_NANO: String(GRAM_ORDER_VALUE_NANO),
  });
  delete coordinatorEnv["GRAM_SIGNER_MNEMONIC"];

  const watcherEnv: Record<string, string> = {
    ...baseEnv,
    FEDERATION_N: String(fedCfg.n),
    FEDERATION_THRESHOLD: String(fedCfg.threshold),
    COORDINATOR_URL: "http://127.0.0.1:8080",
    // Don't refund a mint that is still legitimately collecting on-chain approvals.
    DISPATCHER_WINDOW_MS: String(DISPATCHER_WINDOW_MS),
  };

  const tonOwner = cfg.gram.burnOwner; // wVIZ mint recipient
  console.log(`[fed-ton] run=${cfg.runId} federation=${fedCfg.threshold}-of-${fedCfg.n} (${fedCfg.operators.map((o) => o.id).join(",")})`);

  // Preflight: VIZ principal + fee headroom for the several locks we will submit.
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal}, need ${cfg.viz.minBalanceMilliViz}`);
  }

  try {
    await proveThresholdMint(cfg, fees, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner);
    await proveUnderThreshold(cfg, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner, fedCfg.n, fedCfg.threshold);
    await proveCrashWindow(cfg, fees, store, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner);
    const rotated = await proveRotation(cfg, fedCfg);

    console.log(`\n[fed-ton] ✓ §9b LIVE 3-of-5 PROOF COMPLETE`);
    console.log(
      `[fed-ton]   threshold mint ✓  under-threshold no-mint ✓  crash-window single-mint ✓  ` +
        (rotated ? "rotation ✓" : "rotation ⇢ SKIPPED (set FED_ROTATION_MODE=live to run it)"),
    );
  } finally {
    await store.close();
  }
}

/** Bring up the M signers + keyless coordinator + watchers, run `body`, tear down. */
async function withStack<T>(
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  body: (fed: FederationStack, watchers: LaunchedStack) => Promise<T>,
): Promise<T> {
  const fed = await launchFederationStack(signerSpecs, coordinatorEnv, logDir);
  const watchers = await launchStack([...WATCHERS], watcherEnv, logDir);
  try {
    return await body(fed, watchers);
  } finally {
    await watchers.stop();
    await fed.stopAll();
  }
}

// ── Criterion 1: threshold mint ─────────────────────────────────────────────
async function proveThresholdMint(
  cfg: ReturnType<typeof loadE2eConfig>,
  fees: ReturnType<typeof loadConfig>["fees"],
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
): Promise<void> {
  console.log(`\n[fed-ton] Criterion 1: threshold mint (3 independent on-chain approvals)`);
  // Base must clear TON's dynamic peg-in floor (base fee + mint-gas floor ≈ 21_000
  // mVIZ). uniqueGrossMilliViz adds only 0–999 jitter, so 20_000n always landed
  // below the floor and the coordinator refunded before any approval.
  const gross = uniqueGrossMilliViz(25_000n, `${cfg.runId}-mint`);
  const net = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  const { seqno: seqnoBefore } = await nextOrderInfo(cfg);

  await withStack(signerSpecs, coordinatorEnv, watcherEnv, `${logDir}-c1`, async () => {
    const lockTx = await submitLock(cfg, gross, `ton:${tonOwner}`);
    console.log(`[fed-ton]   peg-in lock: ${lockTx}`);
    const wvizAfter = await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: MINT_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "threshold mint credits net" },
    );
    const delta = wvizAfter - wvizBefore;
    if (delta !== net) throw new Error(`mint delta ${delta} != net ${net}`);
  });

  const seqnoAfter = await nextOrderSeqno(cfg);
  if (seqnoAfter !== seqnoBefore + 1n) {
    throw new Error(`expected exactly one order (seqno ${seqnoBefore}->${seqnoBefore + 1n}), got ${seqnoAfter}`);
  }
  console.log(`[fed-ton]   ✓ wVIZ +${net}; one order created (seqno ${seqnoBefore}->${seqnoAfter}); 3-of-5 threshold reached`);
}

// ── Criterion 2: under-threshold no-mint ────────────────────────────────────
async function proveUnderThreshold(
  cfg: ReturnType<typeof loadE2eConfig>,
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
  n: number,
  threshold: number,
): Promise<void> {
  const toKill = n - threshold + 1; // kill enough that the remaining live set < threshold
  console.log(`\n[fed-ton] Criterion 2: under-threshold (kill ${toKill} of ${n} signers → no mint)`);
  const gross = uniqueGrossMilliViz(25_000n, `${cfg.runId}-under`);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);

  // Short window so the under-threshold peg-in refunds (terminal) before criterion 3.
  const c2WatcherEnv = { ...watcherEnv, DISPATCHER_WINDOW_MS: String(UNDER_THRESHOLD_WINDOW_MS) };

  await withStack(signerSpecs, coordinatorEnv, c2WatcherEnv, `${logDir}-c2`, async (fed) => {
    // Keep the proposer (index 0) alive so it CAN create the order, but starve the
    // approvals below threshold: kill the last `toKill` signers.
    for (let i = fed.signers.length - 1; i >= fed.signers.length - toKill; i--) {
      fed.signers[i]!.kill();
      console.log(`[fed-ton]   killed signer ${fed.signers[i]!.operatorId}`);
    }
    const lockTx = await submitLock(cfg, gross, `ton:${tonOwner}`);
    console.log(`[fed-ton]   peg-in lock: ${lockTx} — waiting to confirm NO mint lands`);
    // Wait a full mint-settle window; assert the balance never moves.
    const deadline = Date.now() + UNDER_THRESHOLD_WAIT_MS;
    while (Date.now() < deadline) {
      const b = await tonWvizBalance(cfg, tonOwner);
      if (b !== wvizBefore) throw new Error(`UNDER-THRESHOLD MINT: wVIZ moved ${wvizBefore}->${b} with only ${threshold - 1} live signers`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });

  const after = await tonWvizBalance(cfg, tonOwner);
  if (after !== wvizBefore) throw new Error(`UNDER-THRESHOLD MINT (post-teardown): wVIZ ${wvizBefore}->${after}`);
  console.log(`[fed-ton]   ✓ order never reached ${threshold} approvals; wVIZ unchanged at ${after}`);
}

// ── Criterion 3: crash-window single-mint (no double-mint) ──────────────────
// Reuses the nextOrderSeqno oracle from tools/e2e/crash-recovery.ts, in the
// federation topology: kill the whole stack after the order lands, relaunch, and
// assert the order is NOT recreated (seqno stable) and the mint credits once.
async function proveCrashWindow(
  cfg: ReturnType<typeof loadE2eConfig>,
  fees: ReturnType<typeof loadConfig>["fees"],
  store: ReturnType<typeof createStore>,
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
): Promise<void> {
  console.log(`\n[fed-ton] Criterion 3: crash-window single-mint (no double-mint)`);
  // Fast orphan recovery so the relaunched stack requeues within seconds.
  const fastWatcherEnv = { ...watcherEnv, DISPATCHER_SIGNING_TIMEOUT_PEG_IN_MS: "8000", DISPATCHER_INTERVAL_MS: "3000" };
  const gross = uniqueGrossMilliViz(25_000n, `${cfg.runId}-crash`);
  const net = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);
  const { orderAddr: predicted, seqno: seqnoBefore } = await nextOrderInfo(cfg);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);

  // Round 1: drive until the order lands on-chain, then crash the whole stack.
  const fed1 = await launchFederationStack(signerSpecs, coordinatorEnv, `${logDir}-c3a`);
  let watchers1: LaunchedStack | null = await launchStack([...WATCHERS], fastWatcherEnv, `${logDir}-c3a`);
  const lockAt = Date.now();
  let rowId: string;
  try {
    const lockTx = await submitLock(cfg, gross, `ton:${tonOwner}`);
    console.log(`[fed-ton]   peg-in lock: ${lockTx}`);
    const row = await pollUntil(async () => await findPegInRow(store, tonOwner, lockAt), {
      timeoutMs: FIND_ROW_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in row appears",
    });
    rowId = row.id;
    await pollUntil(async () => ((await orderExists(cfg, predicted)) ? true : null), {
      timeoutMs: ORDER_LANDS_TIMEOUT_MS, intervalMs: POLL_MS, label: "new_order lands",
    });
    console.log(`[fed-ton]   order landed at ${predicted} — CRASHING stack`);
  } finally {
    await watchers1.stop();
    watchers1 = null;
    await fed1.stopAll();
  }

  // Strand the row in BROADCAST (as crash-recovery.ts does) so orphan recovery
  // treats it as crashed-mid-flight regardless of the CONFIRMED race.
  const stranded = await store.get(rowId);
  if (!stranded) throw new Error(`row ${rowId} vanished after crash`);
  if (stranded.txid !== predicted) {
    throw new Error(`persist-before-send violated: row txid=${stranded.txid} != predicted ${predicted}`);
  }
  await store.setStatus(rowId, "BROADCAST");
  const seqnoAfterMint = await nextOrderSeqno(cfg);
  if (seqnoAfterMint !== seqnoBefore + 1n) {
    throw new Error(`expected exactly one order before recovery (seqno ${seqnoBefore}->${seqnoBefore + 1n}), got ${seqnoAfterMint}`);
  }

  // Round 2: relaunch — recovery must short-circuit, NOT create a second order.
  await withStack(signerSpecs, coordinatorEnv, fastWatcherEnv, `${logDir}-c3b`, async () => {
    const recovered = await pollUntil(
      async () => {
        const r = await store.get(rowId);
        return r && r.status === "CONFIRMED" ? r : null;
      },
      { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: POLL_MS, label: "recovery -> CONFIRMED" },
    );
    console.log(`[fed-ton]   recovered to CONFIRMED (txid=${recovered.txid})`);
  });

  const seqnoAfterRecovery = await nextOrderSeqno(cfg);
  if (seqnoAfterRecovery !== seqnoAfterMint) {
    throw new Error(`DOUBLE-MINT: nextOrderSeqno ${seqnoAfterMint}->${seqnoAfterRecovery} during recovery`);
  }
  const wvizAfter = await pollUntil(
    async () => {
      const b = await tonWvizBalance(cfg, tonOwner);
      return b - wvizBefore === net ? b : null;
    },
    { timeoutMs: MINT_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "single mint credited" },
  );
  if (wvizAfter - wvizBefore !== net) throw new Error(`mint delta ${wvizAfter - wvizBefore} != net ${net}`);
  console.log(`[fed-ton]   ✓ no second order (seqno stable at ${seqnoAfterRecovery}); wVIZ credited +${net} once`);
}

// ── Criterion 4: rotation rejects old signers ───────────────────────────────
// A live multisig signer-set rotation (update_multisig_params via the order
// contract) drives the deployed multisig from its current set to one with an
// operator dropped, then proves the dropped operator's on-chain `approve` is
// rejected (err 106 unauthorized_sign) while the retained set still reaches
// threshold. The full ceremony is automated in ./ton-rotation (proveRotationLive).
//
// SAFETY: this PERMANENTLY rotates the deployed multisig (3-of-5 -> 3-of-4), so it
// is opt-in via FED_ROTATION_MODE=live and runs last. When unset, it is SKIPPED
// (criteria 1-3 still prove out); re-running after a rotation needs a fresh 3-of-5
// deploy (RUNBOOK §9b step 0-1). Returns true iff the rotation proof actually ran.
async function proveRotation(
  cfg: ReturnType<typeof loadE2eConfig>,
  fedCfg: ReturnType<typeof loadFederationConfig>,
): Promise<boolean> {
  console.log(`\n[fed-ton] Criterion 4: rotation rejects old signers`);
  if (process.env.FED_ROTATION_MODE !== "live") {
    console.log(
      `[fed-ton]   ⇢ SKIPPED. This criterion PERMANENTLY rotates ${cfg.gram.multisigAddress} ` +
        `(drops one operator). Set FED_ROTATION_MODE=live to run it (last), then re-deploy a ` +
        `fresh ${fedCfg.threshold}-of-${fedCfg.n} to re-run the suite (RUNBOOK §9b step 0-1).`,
    );
    return false;
  }
  const operators = fedCfg.operators.map((o) => ({ id: o.id, gramMnemonic: o.gramMnemonic! }));
  await proveRotationLive(cfg, operators);
  return true;
}

/** Newest active PEG_IN/TON row minting to `owner`, created at/after `since`. */
async function findPegInRow(
  store: ReturnType<typeof createStore>,
  owner: string,
  since: number,
): Promise<OutboxRecord | null> {
  const rows = await store.stale(Date.now() + 1, 0, ["QUEUED", "BROADCAST", "CONFIRMED"]);
  const mine = rows
    .filter((r) => r.direction === "PEG_IN" && r.remoteChain === "GRAM" && r.recipient === owner && r.createdAt >= since - 5_000)
    .sort((a, b) => b.createdAt - a.createdAt);
  return mine[0] ?? null;
}

main().catch((err) => {
  console.error(`[fed-ton] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
