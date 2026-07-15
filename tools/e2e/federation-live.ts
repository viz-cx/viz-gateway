// tools/e2e/federation-live.ts — LIVE 3-of-3 federation FULL round-trip proof.
//
// Proves both legs of a GRAM round trip through ONE federation stack of the three
// operators FED_OP1/2/3, at threshold 3. This single 3-of-3 set satisfies BOTH
// on-chain authorities without any solo/1-of-1 shortcut:
//
//   Peg-in  (VIZ lock → wVIZ mint): the wVIZ minter admin is a 3-of-5 multisig
//     (FED_OP1..5). FED_OP1/2/3 are three of those five signers, so their three
//     independent on-chain approvals reach the minter's 3-of-5 threshold and the
//     mint lands. Each operator approves from its OWN wallet (FED_OP<i>_GRAM_MNEMONIC);
//     the coordinator holds no TON key.
//
//   Peg-out (wVIZ burn → VIZ release): tester4's VIZ active authority is a 2-of-3
//     multisig keyed to FED_OP1/2/3. The coordinator fans the release proposal out to
//     the three signers, collects three VIZ partial signatures, and broadcasts one
//     multisig transfer. VIZ accepts it because ≥2 of the 3 registered active keys
//     signed — a credited recipient balance IS proof of ≥2-of-3 signature collection.
//
// Why exactly FED_OP1/2/3 (not the full 3-of-5 set): FED_OP4/5 are minter signers but
// are NOT in tester4's VIZ active authority, so their VIZ partial signatures would be
// rejected by the chain. Restricting the federation to the three operators that are
// signers on BOTH authorities is what makes a single stack drive the whole round trip.
//
// This is the happy-path counterpart to the §9b criteria driver (federation-ton-live.ts),
// which proves threshold/under-threshold/crash/rotation on the peg-in leg only.
//
// SAFETY: submits a real testnet VIZ lock, mints real testnet wVIZ, then burns it and
// releases real testnet VIZ. Net principal effect is ~0 (round trip) minus the peg-in fee.
//
// Prereqs: .env.e2e carrying FED_OP1/2/3_ID/WIF/GRAM_MNEMONIC, the shared
// E2E_GRAM_MULTISIG_ADDRESS / E2E_GRAM_JETTON_MINTER_ADDRESS (minter admin = the 3-of-5),
// and tester4 (E2E_VIZ_GATEWAY_ACCOUNT) still on its 2-of-3 FED_OP1/2/3 active authority.
//
// Run: npm run e2e:federation:live
import { loadConfig, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { loadFederationConfig, buildFederationRunEnv } from "./federation-config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { assertDelta } from "./deltas";
import { pollUntil } from "./poll";
import { launchStack, launchFederationStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { submitBurn, tonWvizBalance, minterTonBalance } from "./ton";
import { Address } from "@ton/ton";

// Live testnet latencies: the peg-in mint waits on VIZ irreversibility lag + 3
// SEQUENTIAL on-chain TON approvals + toncenter 504 retries (observed ~5 min), and
// the peg-out release waits on the coordinator collecting 3 VIZ sigs + VIZ inclusion.
// Windows are generous so a correctly-landing transfer is never timed out.
const PEG_IN_TIMEOUT_MS = 10 * 60_000;
const PEG_OUT_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 5_000;
// Don't refund a mint that is still legitimately collecting on-chain approvals: the
// dispatcher's 3-min default is shorter than the ~5-min live mint (VG mid-flight refund).
const DISPATCHER_WINDOW_MS = 8 * 60_000;
// Each signer's GramApprover waits for its proposed order / approval to land on-chain;
// the 60s default is too tight for testnet inclusion + toncenter view lag.
const GRAM_APPROVE_MAX_WAIT_MS = 150_000;
// NOTE: the orchestrator's per-signer /approve ceiling is now DIRECTION-AWARE in config
// (coordinator.signerApproveTimeoutMs = { pegIn: 180s, pegOut: 30s }), so the GRAM peg-in
// leg — where a signer does a REAL on-chain propose/approve for GRAM_APPROVE_MAX_WAIT_MS —
// no longer needs a manual SIGNER_APPROVE_TIMEOUT_MS override here (which used to force the
// peg-out release to 180s too). The driver inherits the correct defaults.
// The dispatcher's /submit call wraps the coordinator's FULL orchestration — up to 3
// signers approved SEQUENTIALLY (3 × the peg-in /approve ceiling) plus the execute poll.
// The 300s default is shorter than that worst case, so widen it (and the SIGNING requeue
// clock) to keep a legitimately-slow mint from being aborted or requeued mid-flight.
const DISPATCHER_SUBMIT_TIMEOUT_MS = 12 * 60_000;
// TON (nano) the proposer attaches per order — ~0.1 TON + gas, 0.3 covers it with margin.
const GRAM_ORDER_VALUE_NANO = 300_000_000;

async function main() {
  const cfg = loadE2eConfig(process.env, "gram");
  const fullFed = loadFederationConfig(process.env);

  // Restrict to the three operators that are signers on BOTH the 3-of-5 minter admin
  // AND tester4's 2-of-3 VIZ active authority. Force a 3-of-3 threshold regardless of
  // the .env FED_N/FED_THRESHOLD (which are tuned for the §9b 3-of-5 driver).
  if (fullFed.operators.length < 3) {
    throw new Error(`round trip needs at least 3 operators configured; got ${fullFed.operators.length}`);
  }
  const fedCfg = { n: 3, threshold: 3, basePort: fullFed.basePort, operators: fullFed.operators.slice(0, 3) };
  if (fedCfg.operators.some((o) => !o.gramMnemonic)) {
    throw new Error("each of FED_OP1/2/3 needs its OWN FED_OP<i>_GRAM_MNEMONIC to approve the 3-of-5 minter");
  }

  const baseEnv = buildRunEnv(cfg);
  // Merge base env so loadConfig() picks up shared vars (fees, backing accounts, etc.).
  Object.assign(process.env, baseEnv);
  const fees = loadConfig().fees;
  const logDir = `tools/e2e/logs/fed-live-${cfg.runId}`;

  // The coordinator is KEYLESS on TON: it designates the first federation operator as
  // proposer (op-1, first in signerSpecs), so strip any TON mnemonic from its env.
  const { signerSpecs, coordinatorEnv } = buildFederationRunEnv(fedCfg, {
    ...baseEnv,
    COORDINATOR_LISTEN: "127.0.0.1:8100",
    COORDINATOR_URL: "http://127.0.0.1:8100",
    GRAM_APPROVE_MAX_WAIT_MS: String(GRAM_APPROVE_MAX_WAIT_MS),
    GRAM_ORDER_VALUE_NANO: String(GRAM_ORDER_VALUE_NANO),
  });
  delete coordinatorEnv["GRAM_SIGNER_MNEMONIC"];

  const watcherEnv: Record<string, string> = {
    ...baseEnv,
    FEDERATION_N: String(fedCfg.n),
    FEDERATION_THRESHOLD: String(fedCfg.threshold),
    COORDINATOR_URL: "http://127.0.0.1:8100",
    DISPATCHER_WINDOW_MS: String(DISPATCHER_WINDOW_MS),
    DISPATCHER_SUBMIT_TIMEOUT_MS: String(DISPATCHER_SUBMIT_TIMEOUT_MS),
    DISPATCHER_SIGNING_TIMEOUT_PEG_IN_MS: String(DISPATCHER_SUBMIT_TIMEOUT_MS),
  };

  // wVIZ mint recipient = burn wallet owner. Normalize to a bare EQ/UQ address: post
  // per-network-accounts (PR #32) the peg-in memo carries the raw remote address with
  // NO "ton:" prefix (validateRemoteAddress rejects colons); the 0Q testnet display
  // form is the same account, different tag, which the regex rejects.
  const tonOwner = Address.parse(cfg.gram.burnOwner).toString();
  const recvAcct = cfg.viz.recipient;
  const gross = uniqueGrossMilliViz(25_000n, cfg.runId); // must clear the TON peg-in floor (~21_000)
  const net = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);

  console.log(`[fed-live] run=${cfg.runId} federation=${fedCfg.threshold}-of-${fedCfg.n} (${fedCfg.operators.map((o) => o.id).join(",")})`);
  console.log(`[fed-live] gross=${gross} net=${net} recipient=${recvAcct}`);

  // Preflight: VIZ principal + fee headroom for the lock.
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal} mVIZ, need ${cfg.viz.minBalanceMilliViz}`);
  }

  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  const recvBefore = await vizBalanceMilliViz(cfg.viz.nodeUrl, recvAcct);
  // PR #59 verification: snapshot the minter's TON balance so we can measure the
  // per-mint accretion once the mint lands (expected ~0.008 TON with attached value
  // lowered 0.1→0.06, vs the ~0.049 measured under the old 0.1 attach).
  const minterTonBefore = await minterTonBalance(cfg);
  console.log(`[fed-live]   minter TON before: ${minterTonBefore} nano`);

  // Bring up ONE stack: 3 signers + keyless coordinator, plus the watchers/dispatcher.
  const fed = await launchFederationStack(signerSpecs, coordinatorEnv, logDir);
  const watchers = await launchStack(["viz-watcher", "gram-watcher", "dispatcher"], watcherEnv, logDir);

  try {
    // ── Peg-in: lock VIZ (bare memo = burn-wallet address) → 3-of-5 minter mints wVIZ ──
    console.log(`\n[fed-live] Peg-in: lock ${gross} mVIZ → mint ${net} wVIZ (3 approvals reach the 3-of-5 minter)`);
    const lockTx = await submitLock(cfg, gross, tonOwner);
    console.log(`[fed-live]   peg-in lock: ${lockTx}`);
    const wvizAfter = await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: PEG_IN_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in mint (3-of-5)" },
    );
    assertDelta("ton-wviz (peg-in)", wvizBefore, wvizAfter, net);
    console.log(`[fed-live]   ✓ minted +${net} wVIZ`);

    // PR #59 verification: measure minter TON accretion from THIS mint, before the
    // peg-out burn perturbs the minter balance. Old attach (0.1) accreted ~0.049 TON;
    // the 0.06 attach should land ~0.008 TON (~82% less). Report-only (does not gate
    // the round-trip proof), since live gas/fee jitter makes an exact assert brittle.
    const minterTonAfterMint = await minterTonBalance(cfg);
    const mintAccretionNano = minterTonAfterMint - minterTonBefore;
    console.log(
      `[fed-live]   minter TON after mint: ${minterTonAfterMint} nano ` +
        `(Δ=${mintAccretionNano} nano ≈ ${(Number(mintAccretionNano) / 1e9).toFixed(4)} TON per mint)`,
    );

    // ── Peg-out: burn wVIZ (comment = VIZ recipient) → 2-of-3 VIZ release ─────────────
    console.log(`\n[fed-live] Peg-out: burn ${net} wVIZ → release VIZ to ${recvAcct} (3 sigs reach tester4's 2-of-3)`);
    await submitBurn(cfg, net, recvAcct); // PEG_OUT/FEE_SWEEP/REFUND are fee-free: burn net → release net
    console.log(`[fed-live]   peg-out burn submitted`);
    const recvAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(cfg.viz.nodeUrl, recvAcct);
        return b - recvBefore === net ? b : null;
      },
      { timeoutMs: PEG_OUT_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-out release (2-of-3)" },
    );
    assertDelta("viz-release (2-of-3)", recvBefore, recvAfter, net);

    console.log(`\n[fed-live] ✓ 3-of-3 FEDERATION ROUND TRIP COMPLETE`);
    console.log(`[fed-live]   peg-in mint ✓ (3-of-5 minter) · peg-out release ✓ (2-of-3 VIZ)`);
    console.log(`[fed-live]   released +${net} mVIZ to ${recvAcct} via ${fedCfg.operators.map((o) => o.id).join(",")}`);
  } finally {
    await watchers.stop();
    await fed.stopAll();
  }
}

main().catch((err) => {
  console.error(`[fed-live] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
