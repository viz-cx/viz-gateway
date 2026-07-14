// tools/e2e/federation-ton-live.ts — LIVE 3-of-5 TON peg-in proof (RUNBOOK §9b).
//
// Proves the Phase B trust boundary on TON testnet: FIVE independent operator
// wallets, a KEYLESS coordinator, and a wVIZ mint that only lands once THREE
// distinct operators approve on-chain. Each signer approves from its OWN TON
// wallet (FED_OP<i>_GRAM_MNEMONIC) — the coordinator holds no TON key.
//
// This is the live counterpart of tools/gram-onchain-approval-spike.cjs (which
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
// FED_N=5, FED_THRESHOLD=3, FED_OP{1..5}_ID/WIF/GRAM_MNEMONIC + the shared
// E2E_GRAM_MULTISIG_ADDRESS / E2E_GRAM_JETTON_MINTER_ADDRESS.
//
// Run: npm run e2e:federation:gram:live
import { createStore, loadConfig, baseFee, pegInFeePolicyFor, type OutboxRecord, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { loadFederationConfig, buildFederationRunEnv } from "./federation-config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { pollUntil } from "./poll";
import { launchStack, launchFederationStack, type FederationStack, type LaunchedStack } from "./stack";
import { submitLock, vizBalanceMilliViz, vizAccountExists } from "./viz";
import { tonWvizBalance, nextOrderInfo, nextOrderSeqno, orderExists, submitBurn } from "./ton";
import { Address } from "@ton/ton";
import { proveRotationLive } from "./gram-rotation";

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
// Extra VIZ-release scenarios (fee-sweep / below-min refund / bad-recipient peg-out).
// The FEE_SWEEP and REFUND are VIZ releases spawned only AFTER the peg-in settles, so
// they need their own generous settle windows on top of the mint latency.
const FEE_SWEEP_SETTLE_TIMEOUT_MS = 6 * 60_000;
const REFUND_SETTLE_TIMEOUT_MS = 8 * 60_000;
// Bad-recipient peg-out: after the burn is seen, watch this long to confirm NO VIZ is
// released (the release fails closed and wedges — there is no PEG_OUT auto-refund).
const WEDGE_OBSERVE_MS = 3 * 60_000;

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

  // The coordinator is KEYLESS on TON: strip any TON mnemonic from its env.
  // (op-1 first) — the coordinator orders signers by federation operator order, so the
  // designated proposer (operators[0]) is contacted first once it has registered.
  const { signerSpecs, coordinatorEnv } = buildFederationRunEnv(fedCfg, {
    ...baseEnv,
    COORDINATOR_LISTEN: "127.0.0.1:8080",
    COORDINATOR_URL: "http://127.0.0.1:8080",
    // Each signer's GramApprover waits for its proposed order / approval to land
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

  // wVIZ mint recipient. Normalize to a bare EQ/UQ address: post per-network-accounts
  // (PR #32) routing is by the receiving VIZ account, so the peg-in memo carries the
  // raw remote address with NO "ton:" prefix, and validateRemoteAddress requires the
  // EQ/UQ form (the E2E_GRAM_BURN_OWNER is stored in 0Q testnet form — same account,
  // different display tag — which the regex rejects).
  const tonOwner = Address.parse(cfg.gram.burnOwner).toString();
  console.log(`[fed-ton] run=${cfg.runId} federation=${fedCfg.threshold}-of-${fedCfg.n} (${fedCfg.operators.map((o) => o.id).join(",")})`);

  // Preflight: VIZ principal + fee headroom for the several locks we will submit.
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal}, need ${cfg.viz.minBalanceMilliViz}`);
  }

  // Extra-only: prove the VIZ-RELEASE scenarios not covered by criteria 1-3 (which are
  // peg-in/mint only and never release VIZ). FEE_SWEEP, below-min REFUND, and the
  // bad-recipient PEG_OUT all exercise the federation VIZ-release path for the first time.
  if (process.env.FED_EXTRA_ONLY === "1") {
    const feesGate = loadConfig().feesGateAccount;
    console.log(`[fed-ton] run=${cfg.runId} EXTRA-ONLY (VIZ-release scenarios) feesGate=${feesGate}`);
    try {
      await proveFeeSweep(cfg, fees, feesGate, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner);
      await proveBelowMinRefund(cfg, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner);
      if (process.env.FED_PEGOUT_MODE === "live") {
        await proveBadRecipientPegOut(cfg, signerSpecs, coordinatorEnv, watcherEnv, logDir, tonOwner);
      } else {
        console.log(`[fed-ton] bad-recipient peg-out ⇢ SKIPPED (set FED_PEGOUT_MODE=live; strands wVIZ at the gateway)`);
      }
      console.log(`\n[fed-ton] ✓ EXTRA VIZ-release scenarios complete`);
    } finally {
      await store.close();
    }
    return;
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
    const lockTx = await submitLock(cfg, gross, tonOwner);
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
    const lockTx = await submitLock(cfg, gross, tonOwner);
    console.log(`[fed-ton]   peg-in lock: ${lockTx} — waiting to confirm NO mint lands`);
    // Wait a full mint-settle window; assert the balance never moves.
    const deadline = Date.now() + UNDER_THRESHOLD_WAIT_MS;
    while (Date.now() < deadline) {
      // A transient toncenter read failure is NOT evidence of a mint — only a
      // SUCCESSFUL read showing a moved balance fails this criterion. Swallow read
      // errors and keep watching to the deadline (the assertion is "never moved").
      try {
        const b = await tonWvizBalance(cfg, tonOwner);
        if (b !== wvizBefore) throw new Error(`UNDER-THRESHOLD MINT: wVIZ moved ${wvizBefore}->${b} with only ${threshold - 1} live signers`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("UNDER-THRESHOLD MINT")) throw err;
        console.warn(`[fed-ton]   (under-threshold) transient balance read error, ignoring: ${(err as Error).message}`);
      }
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
    const lockTx = await submitLock(cfg, gross, tonOwner);
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
// threshold. The full ceremony is automated in ./gram-rotation (proveRotationLive).
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

// ── Criterion 5: FEE_SWEEP lands the base fee in fees.gate ───────────────────
// A peg-in withholds `base` from net; the dispatcher then spawns a FEE_SWEEP — a
// federation VIZ release of exactly `base` to fees.gate (VG-04: base only, never
// the activation surcharge). This is the FIRST live exercise of the federation
// VIZ-release path (criteria 1-3 only mint on TON).
async function proveFeeSweep(
  cfg: ReturnType<typeof loadE2eConfig>,
  fees: ReturnType<typeof loadConfig>["fees"],
  feesGate: string,
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
): Promise<void> {
  console.log(`\n[fed-ton] Criterion 5: FEE_SWEEP -> fees.gate (federation VIZ release)`);
  const gross = uniqueGrossMilliViz(25_000n, `${cfg.runId}-fee`);
  const net = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);
  const base = baseFee(gross, pegInFeePolicyFor(fees, "GRAM" as RemoteChainId)); // exact swept amount
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  const feesBefore = await vizBalanceMilliViz(cfg.viz.nodeUrl, feesGate);
  console.log(`[fed-ton]   gross=${gross} net=${net} base(=swept)=${base}`);

  await withStack(signerSpecs, coordinatorEnv, watcherEnv, `${logDir}-c5`, async () => {
    const lockTx = await submitLock(cfg, gross, tonOwner);
    console.log(`[fed-ton]   peg-in lock: ${lockTx}`);
    await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: MINT_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "mint credits net" },
    );
    console.log(`[fed-ton]   minted +${net}; awaiting FEE_SWEEP of ${base} to ${feesGate}`);
    // Keep the stack UP: the sweep is a VIZ release the dispatcher spawns only after
    // the peg-in is CONFIRMED, so it must complete before teardown.
    const feesAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(cfg.viz.nodeUrl, feesGate);
        return b - feesBefore === base ? b : null;
      },
      { timeoutMs: FEE_SWEEP_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "fee sweep to fees.gate" },
    );
    if (feesAfter - feesBefore !== base) {
      throw new Error(`fee-sweep delta ${feesAfter - feesBefore} != base ${base}`);
    }
  });
  console.log(`[fed-ton]   ✓ fees.gate received exactly ${base} mVIZ (base only, no activation)`);
}

// ── Criterion 6: below-minimum peg-in refunds GROSS to the sender ────────────
// A deposit whose NET can't clear the mint-gas floor is rejected (no mint); the
// dispatcher's delivery window then exhausts and a REFUND returns the full GROSS
// (no fee on a refund) to the original VIZ sender — another federation VIZ release.
async function proveBelowMinRefund(
  cfg: ReturnType<typeof loadE2eConfig>,
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
): Promise<void> {
  console.log(`\n[fed-ton] Criterion 6: below-minimum peg-in refunds gross to sender`);
  // NET = gross - base(10_000) must fall UNDER the mint-gas floor (~11_000). gross
  // 15_000 -> net 5_000 is safely BELOW_MIN, so the coordinator rejects for refund.
  const grossLow = 15_000n;
  const sender = cfg.viz.testAccount;
  const senderBefore = await vizBalanceMilliViz(cfg.viz.nodeUrl, sender);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  console.log(`[fed-ton]   grossLow=${grossLow} sender=${sender} senderBefore=${senderBefore}`);

  // Short delivery window so the below-min deposit refunds (terminal) within the criterion.
  const c6WatcherEnv = { ...watcherEnv, DISPATCHER_WINDOW_MS: String(UNDER_THRESHOLD_WINDOW_MS) };

  await withStack(signerSpecs, coordinatorEnv, c6WatcherEnv, `${logDir}-c6`, async () => {
    const lockTx = await submitLock(cfg, grossLow, tonOwner);
    console.log(`[fed-ton]   below-min lock: ${lockTx} — expecting refund of ${grossLow} to ${sender}`);
    const senderAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(cfg.viz.nodeUrl, sender);
        // VIZ transfers are feeless, so a full-gross refund restores the pre-lock balance.
        return b === senderBefore ? b : null;
      },
      { timeoutMs: REFUND_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "gross refunded to sender" },
    );
    const wvizAfter = await tonWvizBalance(cfg, tonOwner);
    if (wvizAfter !== wvizBefore) {
      throw new Error(`BELOW-MIN MINTED: wVIZ moved ${wvizBefore}->${wvizAfter} for a sub-minimum deposit`);
    }
    console.log(`[fed-ton]   sender restored to ${senderAfter}; wVIZ unchanged at ${wvizAfter}`);
  });
  console.log(`[fed-ton]   ✓ below-min deposit refunded gross ${grossLow}; no wVIZ minted`);
}

// ── Criterion 7: peg-out to a nonexistent recipient fails closed ─────────────
// A burn whose comment names a VIZ account that does not exist cannot be released
// (the VIZ transfer would target nothing). There is NO PEG_OUT auto-refund, so the
// release wedges for staff — the invariant is that NO VIZ is ever released and the
// bad account is never created. SAFETY: the burned wVIZ moves to the gateway wallet
// and stays there (recoverable by staff), so this is opt-in via FED_PEGOUT_MODE=live.
async function proveBadRecipientPegOut(
  cfg: ReturnType<typeof loadE2eConfig>,
  signerSpecs: ReturnType<typeof buildFederationRunEnv>["signerSpecs"],
  coordinatorEnv: Record<string, string>,
  watcherEnv: Record<string, string>,
  logDir: string,
  tonOwner: string,
): Promise<void> {
  console.log(`\n[fed-ton] Criterion 7: peg-out to nonexistent recipient fails closed (no release)`);
  const badRecipient = "nosuchaccountzz"; // valid VIZ name shape, guaranteed absent
  const burnAmount = 1_000n; // 1 wVIZ
  if (await vizAccountExists(cfg.viz.nodeUrl, badRecipient)) {
    throw new Error(`test precondition broken: ${badRecipient} unexpectedly exists on VIZ`);
  }
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  if (wvizBefore < burnAmount) throw new Error(`burn wallet has ${wvizBefore} wVIZ, need >= ${burnAmount}`);

  await withStack(signerSpecs, coordinatorEnv, watcherEnv, `${logDir}-c7`, async () => {
    await submitBurn(cfg, burnAmount, badRecipient);
    console.log(`[fed-ton]   burned ${burnAmount} wVIZ with comment=${badRecipient} (nonexistent)`);
    // Confirm the burn was reflected (wVIZ left the burn wallet).
    await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b <= wvizBefore - burnAmount ? b : null;
      },
      { timeoutMs: MINT_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "burn reflected on wVIZ balance" },
    );
    console.log(`[fed-ton]   burn seen; observing ${WEDGE_OBSERVE_MS / 1000}s that NO VIZ is released`);
    // The release must fail closed: the bad account is never created/credited.
    const deadline = Date.now() + WEDGE_OBSERVE_MS;
    while (Date.now() < deadline) {
      try {
        if (await vizAccountExists(cfg.viz.nodeUrl, badRecipient)) {
          throw new Error(`FAIL-OPEN: ${badRecipient} exists — a release to a nonexistent recipient was attempted/succeeded`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("FAIL-OPEN")) throw err;
        console.warn(`[fed-ton]   (peg-out) transient VIZ read error, ignoring: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });
  console.log(`[fed-ton]   ✓ no VIZ released to ${badRecipient} (fail-closed; wVIZ held at gateway for staff)`);
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
