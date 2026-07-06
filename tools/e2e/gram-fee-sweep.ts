// tools/e2e/gram-fee-sweep.ts — prove the PEG_IN FEE_SWEEP lands in fees.gate.
//
// The normal round trip (roundtrip.ts) asserts only the NET mint to the recipient;
// it never checks that the withheld `base` fee is actually swept to fees.gate. This
// driver closes that gap (deferred "Task 6" in plan-ton-pegout-source-validation):
//   1. peg-in: lock gross VIZ -> mint NET wVIZ (same as the round trip), then
//   2. assert fees.gate receives EXACTLY `base` (VG-04: only base is ever swept;
//      any activation surcharge is retained on the gateway account, not swept).
//
// SAFETY: real testnet wVIZ mint + a real mainnet VIZ fee sweep (~10 VIZ base).
// Run: npm run e2e:gram:fee-sweep
import { loadConfig, baseFee, pegInFeePolicyFor } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { assertDelta } from "./deltas";
import { pollUntil } from "./poll";
import { launchStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { tonWvizBalance } from "./ton";
import { Address } from "@ton/ton";

const PEG_IN_TIMEOUT_MS = 8 * 60_000;
const FEE_SWEEP_TIMEOUT_MS = 6 * 60_000; // sweep is spawned only AFTER the mint confirms
const POLL_MS = 5_000;

async function main() {
  const cfg = loadE2eConfig(process.env, "gram");
  const runEnv = buildRunEnv(cfg);
  const logDir = `tools/e2e/logs/${cfg.runId}`;
  Object.assign(process.env, runEnv);
  const gwCfg = loadConfig();
  const fees = gwCfg.fees;
  const feesGate = gwCfg.feesGateAccount;

  // Preflight
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal} mVIZ, need ${cfg.viz.minBalanceMilliViz}`);
  }

  // Routing is by the receiving VIZ account (tester4 -> GRAM); the memo carries the
  // raw, normalized remote address with NO "ton:" prefix (validateRemoteAddress
  // rejects colons). Normalize burnOwner (0Q… -> EQ… bounceable) like the federation driver.
  const tonOwner = Address.parse(cfg.gram.burnOwner).toString();
  const gross = uniqueGrossMilliViz(20_000n, cfg.runId);
  const net = expectedNetMilliViz(gross, fees, "GRAM", true);
  const base = baseFee(gross, pegInFeePolicyFor(fees, "GRAM")); // the exact swept amount
  console.log(`[fee] gross=${gross} net=${net} base(=swept)=${base} feesGate=${feesGate}`);

  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  const feesBefore = await vizBalanceMilliViz(cfg.viz.nodeUrl, feesGate);

  const stack = await launchStack(
    ["viz-watcher", "gram-watcher", "signer", "coordinator", "dispatcher"],
    runEnv,
    logDir,
  );

  try {
    // Peg-in: memo is the bare remote address (chain = the receiving account).
    const memo = tonOwner;
    const lockTx = await submitLock(cfg, gross, memo);
    console.log(`[fee] peg-in lock submitted: ${lockTx} gross=${gross} memo=${memo}`);

    const wvizAfter = await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: PEG_IN_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in mint" },
    );
    assertDelta("ton-wviz", wvizBefore, wvizAfter, net);
    console.log(`[fee] peg-in confirmed: minted ${net}; now awaiting FEE_SWEEP of ${base} to ${feesGate}`);

    // The gap: assert the base fee is swept to fees.gate (VG-04 exact-base sweep).
    const feesAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(cfg.viz.nodeUrl, feesGate);
        return b - feesBefore === base ? b : null;
      },
      { timeoutMs: FEE_SWEEP_TIMEOUT_MS, intervalMs: POLL_MS, label: "fee sweep" },
    );
    assertDelta("fees-gate", feesBefore, feesAfter, base);
    console.log(`[fee] FEE_SWEEP OK: ${feesGate} received exactly ${base} mVIZ (base only, no activation)`);
  } finally {
    await stack.stop();
  }
}

main().catch((err) => {
  console.error(`[fee] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
