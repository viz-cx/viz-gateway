// tools/e2e/roundtrip.ts — drive one full cross-chain peg round trip against live chains.
import { loadConfig, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { assertDelta } from "./deltas";
import { pollUntil } from "./poll";
import { launchStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { submitBurn, tonWvizBalance } from "./ton";

const PEG_IN_TIMEOUT_MS = 8 * 60_000;
const PEG_OUT_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 5_000;

async function main() {
  const chain = (process.argv[2] ?? "ton") as "ton" | "solana";
  if (chain !== "ton") throw new Error(`Phase 1 supports 'ton' only; got '${chain}'`);
  const cfg = loadE2eConfig(process.env, chain);
  const runEnv = buildRunEnv(cfg);
  const logDir = `tools/e2e/logs/${cfg.runId}`;

  // Merge run env into process.env so loadConfig() picks up FEDERATION_N=1 etc.
  Object.assign(process.env, runEnv);
  const gwCfg = loadConfig();
  const fees = gwCfg.fees;

  // 1) Preflight: assert test account has enough principal + fee headroom.
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(
      `PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal} mVIZ, need ${cfg.viz.minBalanceMilliViz}`,
    );
  }

  // 2) Snapshot
  const tonOwner = cfg.ton.burnOwner; // burn wallet address = wVIZ mint recipient
  const gross = uniqueGrossMilliViz(20_000n, cfg.runId);
  const net = expectedNetMilliViz(gross, fees, chain.toUpperCase() as RemoteChainId, true);
  const recvBefore = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.recipient);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);

  // 3) Bring up the stack
  const stack = await launchStack(
    ["viz-watcher", "ton-watcher", "signer", "coordinator", "dispatcher"],
    runEnv,
    logDir,
  );

  try {
    // 4) Peg-in: lock VIZ with memo "ton:<burn_wallet_address>"
    const memo = `ton:${tonOwner}`;
    const lockTx = await submitLock(cfg, gross, memo);
    console.log(`[e2e] peg-in lock submitted: ${lockTx} gross=${gross} memo=${memo}`);

    const wvizAfter = await pollUntil(
      async () => {
        const b = await tonWvizBalance(cfg, tonOwner);
        return b - wvizBefore === net ? b : null;
      },
      { timeoutMs: PEG_IN_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in mint" },
    );
    assertDelta("ton-wviz", wvizBefore, wvizAfter, net);
    console.log(`[e2e] peg-in confirmed: minted ${net} base units`);

    // 5) Peg-out: burn the minted wVIZ with comment = the VIZ release recipient
    await submitBurn(cfg, net, cfg.viz.recipient);
    console.log(`[e2e] peg-out burn submitted: ${net} -> ${cfg.viz.recipient}`);

    const recvAfter = await pollUntil(
      async () => {
        const b = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.recipient);
        return b - recvBefore === net ? b : null;
      },
      { timeoutMs: PEG_OUT_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-out release" },
    );
    assertDelta("viz-release", recvBefore, recvAfter, net);
    console.log(`[e2e] ROUND TRIP OK: released ${net} mVIZ to ${cfg.viz.recipient}`);
  } finally {
    await stack.stop();
  }
}

main().catch((err) => {
  console.error(`[e2e] FAILED: ${(err as Error).message}`);
  // Print the full error (stack + any cause) — a bare .message is often empty for
  // wrapped RPC/network errors, which makes a failed live run undiagnosable.
  console.error(err);
  process.exit(1);
});
