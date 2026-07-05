// tools/e2e/crash-recovery.ts — prove TON peg-in on-chain idempotency survives a
// crash in the BROADCAST window WITHOUT double-minting wVIZ.
//
// This is the live counterpart to spike cases 21-24 (tools/idempotent-delivery-spike.cjs):
// the spike proves the GramMintBroadcaster logic against a mocked chain; this driver
// proves the same guarantee end-to-end against a real TON testnet + the full stack.
//
// The double-mint sequence it reproduces (see docs/plan-ton-peg-in-idempotency.md):
//   1. dispatcher marks the peg-in row BROADCAST, POSTs /submit
//   2. coordinator orchestrates -> broadcast() persists the deterministic order
//      address, then sends new_order (mints wVIZ, self-approves 1-of-1)
//   3. CRASH before the dispatcher records CONFIRMED -> row stuck BROADCAST
//   4. orphan recovery requeues -> re-POST /submit
//   5. coordinator.actionExecuted() MUST short-circuit (order exists on-chain) so
//      NO second new_order is created.
//
// The unforgeable "was a second order created?" oracle is the multisig's
// nextOrderSeqno: it advances by exactly 1 per new_order and never rewinds. If it
// is unchanged across recovery, the short-circuit held.
//
// SAFETY: this submits real (testnet) transactions and mints real testnet wVIZ.
// It needs a funded stack per .env.e2e (same as `npm run e2e:ton`). It does NOT
// burn the minted wVIZ back — a normal round trip can sweep it afterwards.
//
// Run: npm run e2e:ton:crash   (env from .env.e2e; see RUNBOOK.md)
import { createStore, loadConfig, type OutboxRecord, type RemoteChainId } from "@gateway/common";
import { loadE2eConfig, buildRunEnv } from "./config";
import { uniqueGrossMilliViz, expectedNetMilliViz } from "./amounts";
import { pollUntil } from "./poll";
import { launchStack, type LaunchedStack } from "./stack";
import { submitLock, vizBalanceMilliViz } from "./viz";
import { tonWvizBalance, nextOrderInfo, nextOrderSeqno, orderExists } from "./ton";

const FIND_ROW_TIMEOUT_MS = 3 * 60_000; // viz-watcher detect + enqueue the peg-in
const ORDER_LANDS_TIMEOUT_MS = 5 * 60_000; // sign + new_order lands on-chain
const RECOVERY_TIMEOUT_MS = 4 * 60_000; // orphan requeue + resubmit + short-circuit
const MINT_SETTLE_TIMEOUT_MS = 3 * 60_000; // async mint execution credits the balance
const POLL_MS = 4_000;

async function main() {
  const cfg = loadE2eConfig(process.env, "gram");
  // Recover fast: shrink the peg-in signing timeout so an orphaned BROADCAST row is
  // requeued seconds (not 5 min) after the crash, and tighten the tick interval.
  const baseEnv = buildRunEnv(cfg);
  const runEnv = {
    ...baseEnv,
    DISPATCHER_SIGNING_TIMEOUT_PEG_IN_MS: "8000",
    DISPATCHER_INTERVAL_MS: "3000",
  };
  const logDir = `tools/e2e/logs/${cfg.runId}-crash`;

  Object.assign(process.env, runEnv);
  const fees = loadConfig().fees;
  const store = createStore(baseEnv.STORE_URL!);

  const tonOwner = cfg.gram.burnOwner; // wVIZ mint recipient
  const gross = uniqueGrossMilliViz(20_000n, cfg.runId);
  const net = expectedNetMilliViz(gross, fees, "GRAM" as RemoteChainId, true);

  // Snapshot BEFORE anything: the seqno the coordinator will consume for this mint,
  // and its deterministic order address (our idempotency key + on-chain landing probe).
  const { orderAddr: predictedOrderAddr, seqno: seqnoBefore } = await nextOrderInfo(cfg);
  const wvizBefore = await tonWvizBalance(cfg, tonOwner);
  console.log(`[crash] run=${cfg.runId} gross=${gross} net=${net}`);
  console.log(`[crash] predicted order seqno=${seqnoBefore} addr=${predictedOrderAddr}`);

  // Preflight VIZ principal + fee headroom.
  const vizBal = await vizBalanceMilliViz(cfg.viz.nodeUrl, cfg.viz.testAccount);
  if (vizBal < cfg.viz.minBalanceMilliViz) {
    throw new Error(`PREFLIGHT: top up ${cfg.viz.testAccount} — have ${vizBal}, need ${cfg.viz.minBalanceMilliViz}`);
  }

  let stack: LaunchedStack | null = null;
  const stop = async () => { if (stack) { await stack.stop(); stack = null; } };
  try {
    // ── Round 1: drive the peg-in until the order lands, then CRASH ──────────────
    stack = await launchStack(["viz-watcher", "gram-watcher", "signer", "coordinator", "dispatcher"], runEnv, logDir);
    const lockAt = Date.now();
    const lockTx = await submitLock(cfg, gross, `ton:${tonOwner}`);
    console.log(`[crash] peg-in lock submitted: ${lockTx}`);

    // Find THIS run's peg-in row: newest PEG_IN/TON row to tonOwner created after the lock.
    const row = await pollUntil(async () => await findPegInRow(store, tonOwner, lockAt), {
      timeoutMs: FIND_ROW_TIMEOUT_MS, intervalMs: POLL_MS, label: "peg-in row appears",
    });
    console.log(`[crash] peg-in row id=${row.id} status=${row.status}`);

    // Wait until the new_order actually lands on-chain (order contract deployed).
    await pollUntil(async () => (await orderExists(cfg, predictedOrderAddr)) ? true : null, {
      timeoutMs: ORDER_LANDS_TIMEOUT_MS, intervalMs: POLL_MS, label: "new_order lands",
    });
    console.log(`[crash] new_order landed on-chain at ${predictedOrderAddr} — CRASHING stack now`);
    await stop(); // SIGKILL the whole stack: mimic a crash before CONFIRMED is recorded

    // Reproduce the stranded state deterministically. The coordinator persists the
    // order address BEFORE send, so the row must already carry txid=predictedOrderAddr.
    // Force it back to BROADCAST (setStatus preserves txid via COALESCE) so orphan
    // recovery treats it exactly as a crashed-mid-flight row — regardless of whether
    // we lost the race and the dispatcher already wrote CONFIRMED before the kill.
    const stranded = await store.get(row.id);
    if (!stranded) throw new Error(`row ${row.id} vanished after crash`);
    console.log(`[crash] post-crash row: status=${stranded.status} txid=${stranded.txid}`);
    if (stranded.txid !== predictedOrderAddr) {
      throw new Error(
        `persist-before-send violated: row txid=${stranded.txid} != predicted ${predictedOrderAddr}. ` +
          `The idempotency key was not durably recorded before the order was sent.`,
      );
    }
    await store.setStatus(row.id, "BROADCAST"); // strand it; updated_at=now, txid kept
    console.log(`[crash] row ${row.id} forced -> BROADCAST (txid preserved) to simulate crash window`);

    // Exactly one order must exist so far.
    const seqnoAfterMint = await nextOrderSeqno(cfg);
    if (seqnoAfterMint !== seqnoBefore + 1n) {
      throw new Error(`expected exactly 1 order created (seqno ${seqnoBefore} -> ${seqnoBefore + 1n}), got ${seqnoAfterMint}`);
    }
    console.log(`[crash] confirmed exactly one order created (seqno ${seqnoBefore} -> ${seqnoAfterMint})`);

    // ── Round 2: relaunch — orphan recovery must short-circuit, NOT re-mint ──────
    stack = await launchStack(["viz-watcher", "gram-watcher", "signer", "coordinator", "dispatcher"], runEnv, logDir);
    console.log(`[crash] stack relaunched — awaiting orphan recovery + actionExecuted short-circuit`);
    const recovered = await pollUntil(async () => {
      const r = await store.get(row.id);
      return r && r.status === "CONFIRMED" ? r : null;
    }, { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: POLL_MS, label: "recovery -> CONFIRMED" });
    console.log(`[crash] row recovered to CONFIRMED (txid=${recovered.txid})`);

    // PRIMARY ORACLE: no second new_order was created.
    const seqnoAfterRecovery = await nextOrderSeqno(cfg);
    if (seqnoAfterRecovery !== seqnoAfterMint) {
      throw new Error(
        `DOUBLE-MINT: multisig nextOrderSeqno advanced ${seqnoAfterMint} -> ${seqnoAfterRecovery} during recovery. ` +
          `actionExecuted did NOT short-circuit — a second order was created.`,
      );
    }
    console.log(`[crash] no second order: nextOrderSeqno stable at ${seqnoAfterRecovery}`);

    // CONFIRMATION: recipient credited net exactly once (not 2x).
    const wvizAfter = await pollUntil(async () => {
      const b = await tonWvizBalance(cfg, tonOwner);
      return b - wvizBefore === net ? b : null;
    }, { timeoutMs: MINT_SETTLE_TIMEOUT_MS, intervalMs: POLL_MS, label: "single mint credited" });
    const delta = wvizAfter - wvizBefore;
    if (delta !== net) throw new Error(`mint delta ${delta} != net ${net} (double-mint would be ${net * 2n})`);

    console.log(`\n[crash] PASS: TON peg-in survived a BROADCAST-window crash with NO double-mint.`);
    console.log(`[crash]   one order (seqno ${seqnoBefore}->${seqnoAfterMint}), recovery short-circuited to CONFIRMED,`);
    console.log(`[crash]   recipient credited net=${net} exactly once. Minted wVIZ left in ${tonOwner}.`);
  } finally {
    await stop();
    await store.close();
  }
}

/** Newest active PEG_IN/TON row minting to `owner`, created at/after `since`. */
async function findPegInRow(
  store: ReturnType<typeof createStore>,
  owner: string,
  since: number,
): Promise<OutboxRecord | null> {
  // stale(now+1, 0, statuses) returns every row in those statuses (updated_at <= now).
  const rows = await store.stale(Date.now() + 1, 0, ["QUEUED", "BROADCAST", "CONFIRMED"]);
  const mine = rows
    .filter((r) => r.direction === "PEG_IN" && r.remoteChain === "GRAM" && r.recipient === owner && r.createdAt >= since - 5_000)
    .sort((a, b) => b.createdAt - a.createdAt);
  return mine[0] ?? null;
}

main().catch((err) => {
  console.error(`[crash] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
