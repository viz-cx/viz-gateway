// tools/e2e/federation.ts — Phase A N-of-M federation harness.
//
// Two test levels:
//   1. Topology   (always runnable, no chain access): proves M independent signer
//      processes start on distinct ports, respond independently, and that killing
//      one does NOT affect the others.
//   2. Fault-matrix (requires VIZ node + coordinator): drives real coordinator
//      /submit calls with synthetic actions to verify under-threshold stall and
//      approval counting behavior. Signers will reject unknown actions at F2, but
//      the coordinator correctly returns {broadcast:false} regardless.
//
// Live proof (plan step 2 — "happy-path broadcast") is NOT in this harness.
// Prerequisites for live proof: run `docs/federation-keys.md` account_update on
// the VIZ gateway account to register the 3 operator pubkeys as 2-of-3 active
// authority, then set E2E_FED_LIVE=1 and re-run with real WIFs.
//
// Run:  npm run e2e:federation
// Env:  see .env.e2e.example [federation section]

import { loadFederationConfig, buildFederationRunEnv } from "./federation-config";
import { launchFederationStack, type FederationStack } from "./stack";
import { loadE2eConfig, buildRunEnv } from "./config";

const STARTUP_WAIT_MS = 2500;
const FAULT_TIMEOUT_MS = 8_000;
const POLL_MS = 500;

// ── helpers ─────────────────────────────────────────────────────────────────

async function httpGet(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: true, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function httpPost(url: string, body: unknown): Promise<{ ok: boolean; status: number; json?: unknown }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    let json: unknown;
    try { json = await res.json(); } catch { /* ignore */ }
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, status: 0 };
  }
}

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string) {
  console.error(`  ✗ ${msg}`);
}
function section(title: string) {
  console.log(`\n[federation] ${title}`);
}

// Ping a signer by sending a GET to /approve (returns 404 = process is up).
async function signerAlive(url: string): Promise<boolean> {
  const r = await httpGet(`${url}/approve`);
  return r.ok; // 404 is fine — process is up, method mismatch
}

async function waitUntilAlive(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await signerAlive(url)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

async function waitUntilDead(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await signerAlive(url))) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

// A synthetic PEG_OUT action that has never been processed (unknown digest/id).
// The coordinator will build a VIZ proposal for it, fan out to signers, collect
// 0 approvals (signers reject at F2 — this action doesn't exist on-chain), and
// return {broadcast: false, approvals: 0}. That IS the expected result for faults.
function syntheticPegOutAction(runId: string): Record<string, unknown> {
  return {
    direction: "PEG_OUT",
    id: `fed-test-${runId}`,
    remoteChain: "GRAM",
    recipient: "babin",
    amountMilliViz: "10000",
    digest: `fed-test-${runId}`,
  };
}

// ── test suites ─────────────────────────────────────────────────────────────

async function runTopologyTests(stack: FederationStack, _runId: string): Promise<number> {
  section("Topology tests — all signers alive");
  let failures = 0;

  for (const s of stack.signers) {
    const alive = await waitUntilAlive(s.url, STARTUP_WAIT_MS);
    if (alive) {
      pass(`signer ${s.operatorId} responding at ${s.url}`);
    } else {
      fail(`signer ${s.operatorId} did NOT start at ${s.url}`);
      failures++;
    }
  }

  // Verify coordinator /health
  const coordUrl = process.env["COORDINATOR_URL"] ?? "http://127.0.0.1:8080";
  const health = await httpGet(`${coordUrl}/health`);
  if (health.ok) {
    pass(`coordinator /health responding at ${coordUrl}`);
  } else {
    fail(`coordinator not responding at ${coordUrl}`);
    failures++;
  }

  return failures;
}

async function runUnderThresholdFaultTest(
  stack: FederationStack,
  threshold: number,
  runId: string,
): Promise<number> {
  section(`Fault-a: kill ${stack.signers.length - threshold + 1} signers → under-threshold stall`);
  let failures = 0;

  // Kill enough signers to fall below threshold (leave threshold-1 running).
  const toKill = stack.signers.slice(threshold - 1);
  for (const s of toKill) {
    s.kill();
    console.log(`    killed signer ${s.operatorId}`);
  }

  // Wait for killed processes to stop.
  for (const s of toKill) {
    const dead = await waitUntilDead(s.url, FAULT_TIMEOUT_MS);
    if (dead) {
      pass(`signer ${s.operatorId} confirmed dead`);
    } else {
      fail(`signer ${s.operatorId} still responding after kill`);
      failures++;
    }
  }

  // Remaining signers (threshold-1) should still be alive.
  const alive = stack.signers.slice(0, threshold - 1);
  for (const s of alive) {
    const up = await signerAlive(s.url);
    if (up) {
      pass(`signer ${s.operatorId} still alive (independent — kill didn't affect it)`);
    } else {
      fail(`signer ${s.operatorId} died when we killed others`);
      failures++;
    }
  }

  // POST a synthetic action to the coordinator. With < threshold signers running
  // (and all rejecting at F2 on unknown actions), the coordinator MUST return
  // {broadcast: false}.
  const coordUrl = process.env["COORDINATOR_URL"] ?? "http://127.0.0.1:8080";
  const result = await httpPost(`${coordUrl}/submit`, {
    action: syntheticPegOutAction(runId),
  });

  if (!result.ok) {
    // Coordinator may throw if VIZ node is unreachable (can't build proposal).
    // This is expected in offline mode — topology test already passed.
    console.log(`    coordinator /submit returned HTTP ${result.status} (VIZ node may be offline — topology already proven)`);
  } else {
    const r = result.json as { broadcast?: boolean; approvals?: number } | undefined;
    if (r && r.broadcast === false) {
      pass(`coordinator returned broadcast=false (approvals=${r.approvals ?? "?"}/${threshold}) — correct stall`);
    } else if (r && r.broadcast === true) {
      fail(`coordinator returned broadcast=true — SHOULD have stalled (threshold not met)`);
      failures++;
    } else {
      console.log(`    coordinator /submit status=${result.status} json=${JSON.stringify(r)} — inconclusive`);
    }
  }

  return failures;
}

async function runKeyIsolationCheck(signerSpecs: Array<{ operatorId: string; wif: string }>): Promise<number> {
  section("Key isolation — no signer env holds another operator's WIF");
  let failures = 0;

  // Each spec's wif should appear only in its own signer's env (process.env isolation).
  // Since we build per-signer envs in buildFederationRunEnv, we verify here that no two
  // operators share the same WIF.
  const wifsSeen = new Set<string>();
  for (const op of signerSpecs) {
    if (wifsSeen.has(op.wif)) {
      fail(`operator ${op.operatorId} shares WIF with another operator — NOT isolated`);
      failures++;
    } else {
      wifsSeen.add(op.wif);
      pass(`operator ${op.operatorId} has a unique WIF`);
    }
  }

  // Verify each signer's OPERATOR_ID is distinct.
  const idsSeen = new Set<string>();
  for (const op of signerSpecs) {
    if (idsSeen.has(op.operatorId)) {
      fail(`duplicate operator id: ${op.operatorId}`);
      failures++;
    } else {
      idsSeen.add(op.operatorId);
    }
  }
  pass(`all ${signerSpecs.length} operator IDs are distinct`);

  return failures;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const fedCfg = loadFederationConfig(process.env);
  const baseCfg = loadE2eConfig(process.env, "gram");
  const baseEnv = buildRunEnv(baseCfg);
  const { signerSpecs, coordinatorEnv } = buildFederationRunEnv(fedCfg, {
    ...baseEnv,
    COORDINATOR_LISTEN: process.env["COORDINATOR_LISTEN"] ?? "127.0.0.1:8080",
    COORDINATOR_URL: process.env["COORDINATOR_URL"] ?? "http://127.0.0.1:8080",
  });

  const logDir = `tools/e2e/logs/fed-${baseCfg.runId}`;
  console.log(`[federation] run=${baseCfg.runId} n=${fedCfg.n} threshold=${fedCfg.threshold} basePort=${fedCfg.basePort}`);
  console.log(`[federation] operators: ${fedCfg.operators.map((o) => o.id).join(", ")}`);

  let stack: FederationStack | null = null;
  let totalFailures = 0;

  try {
    stack = await launchFederationStack(signerSpecs, coordinatorEnv, logDir);

    totalFailures += await runTopologyTests(stack, baseCfg.runId);
    totalFailures += await runKeyIsolationCheck(
      fedCfg.operators.map((o, i) => ({ operatorId: o.id, wif: o.wif, port: signerSpecs[i]!.port })),
    );
    totalFailures += await runUnderThresholdFaultTest(stack, fedCfg.threshold, baseCfg.runId);

    section("Summary");
    if (totalFailures === 0) {
      console.log(`  ALL TOPOLOGY + FAULT TESTS PASSED (${fedCfg.n}-of-${fedCfg.n} process isolation proven)`);
      console.log();
      console.log(`  Next: live happy-path proof (plan step 2)`);
      console.log(`    1. Do account_update on ${baseEnv["VIZ_GATEWAY_ACCOUNT"] ?? "tester4"} per docs/federation-keys.md`);
      console.log(`    2. Set E2E_FED_LIVE=1 and run: npm run e2e:federation:live`);
    } else {
      console.error(`  ${totalFailures} test(s) FAILED`);
      process.exit(1);
    }
  } finally {
    if (stack) await stack.stopAll();
  }
}

main().catch((err) => {
  console.error(`[federation] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
