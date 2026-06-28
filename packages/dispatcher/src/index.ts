import {
  actionToWire,
  createStore,
  loadConfig,
  type CanonicalAction,
  type GatewayStore,
  type OutboxRecord,
} from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { planChildren, planTransition, type DeliveryResult } from "./policy";

/**
 * dispatcher: drains QUEUED outbox rows and delivers each to the coordinator with
 * retries + backoff (P3: every 10s for 3 min, then REFUND). Decouples "detected an
 * action that must happen" (durably persisted by the watchers) from "successfully
 * delivered it" — so nothing is lost on a coordinator/network hiccup or restart.
 *
 * Keyless: it only moves outbox rows; the coordinator holds the orchestration and
 * the signers hold the keys.
 */
/**
 * Map an outbox row to the CanonicalAction the coordinator orchestrates. PEG_IN
 * mints on the remote chain; PEG_OUT / FEE_SWEEP / REFUND are all VIZ releases
 * from the gateway account (to the user / fees.gate / the original sender), so
 * they share the PEG_OUT shape.
 */
function recordToAction(rec: OutboxRecord): CanonicalAction {
  return {
    direction: rec.direction === "PEG_IN" ? "PEG_IN" : "PEG_OUT",
    id: rec.id,
    remoteChain: rec.remoteChain,
    recipient: rec.recipient,
    amountMilliViz: rec.amountMilliViz,
    digest: rec.digest,
  };
}

async function submit(url: string, rec: OutboxRecord): Promise<DeliveryResult> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: actionToWire(recordToAction(rec)) }),
    });
    if (res.status === 423) return { broadcast: false, error: "coordinator paused" };
    if (!res.ok) return { broadcast: false, error: `coordinator HTTP ${res.status}` };
    const body = (await res.json()) as { broadcast?: boolean; txid?: string; error?: string; feeMilliViz?: string };
    return {
      broadcast: Boolean(body.broadcast),
      txid: body.txid,
      feeMilliViz: body.feeMilliViz !== undefined ? BigInt(body.feeMilliViz) : undefined,
      error: body.error,
    };
  } catch (err) {
    return { broadcast: false, error: String(err) };
  }
}

async function tick(
  store: GatewayStore,
  url: string,
  opts: {
    retryIntervalMs: number;
    windowMs: number;
    signingTimeoutMs: { pegIn: number; pegOut: number };
    staleDeliveryAlertMs: number;
    feesGateAccount: string;
  },
  state: { alertedWedged: Set<string> },
): Promise<void> {
  const now = Date.now();
  const alertWedged = (rec: OutboxRecord) => {
    if (state.alertedWedged.has(rec.id)) return;
    const hrs = Math.round(opts.staleDeliveryAlertMs / 3_600_000);
    notifyStaff("delivery", `${rec.id} (${rec.direction}) wedged in ${rec.status} >${hrs}h; federation may be degraded`, {
      id: rec.id,
      status: rec.status,
      attempts: rec.attempts,
      error: rec.lastError,
    });
    state.alertedWedged.add(rec.id);
  };
  // Recover orphaned BROADCAST rows: a crash between marking a row BROADCAST and
  // receiving the coordinator's response would otherwise strand it forever (due()
  // only scans QUEUED). Any row stuck in BROADCAST longer than its per-direction
  // timeout is requeued. The coordinator's actionExecuted check (called at the
  // start of every process()) handles the idempotency: if the action already landed
  // on-chain it short-circuits to CONFIRMED; if not, it broadcasts fresh.
  const minTimeout = Math.min(opts.signingTimeoutMs.pegIn, opts.signingTimeoutMs.pegOut);
  const orphaned = await store.stale(now, minTimeout, ["BROADCAST"]);
  for (const rec of orphaned) {
    const timeout = rec.direction === "PEG_IN" ? opts.signingTimeoutMs.pegIn : opts.signingTimeoutMs.pegOut;
    if (now - rec.updatedAt < timeout) continue; // not yet stale for this direction
    await store.setStatus(rec.id, "QUEUED", { nextAttemptAt: now });
    console.warn(`[dispatcher] recovered orphaned BROADCAST row ${rec.id} (${rec.direction}) -> QUEUED`);
  }

  // Stuck-refund / degraded-federation visibility. A REFUNDING parent is quiescent
  // (its updated_at is stable) so stale() catches it; a QUEUED row bumps updated_at
  // every retry, so it is aged by createdAt in the delivery loop below.
  for (const rec of await store.stale(now, opts.staleDeliveryAlertMs, ["REFUNDING"])) alertWedged(rec);

  // Deliver every QUEUED row (PEG_IN mints; PEG_OUT/FEE_SWEEP/REFUND are VIZ releases).
  const due = await store.due(now, ["QUEUED"]);
  for (const rec of due) {
    if (now - rec.createdAt >= opts.staleDeliveryAlertMs) alertWedged(rec);
    // Mark BROADCAST *before* the coordinator call so a crash between here and
    // CONFIRMED is recoverable: orphaned BROADCAST rows are requeued and the
    // coordinator's actionExecuted check prevents a double-mint/release.
    await store.setStatus(rec.id, "BROADCAST");
    const result = await submit(url, rec);
    const t = planTransition(rec, result, Date.now(), opts);
    await store.setStatus(rec.id, t.status, t.patch);
    if (t.status !== "QUEUED") state.alertedWedged.delete(rec.id); // recovered/advanced — re-arm
    // Spawn FEE_SWEEP (on confirm) or REFUND (on window-exhaust) for a PEG_IN.
    const children = planChildren(rec, t.status, {
      feesGateAccount: opts.feesGateAccount,
      feeMilliViz: result.feeMilliViz ?? 0n,
    });
    for (const child of children) await store.enqueue(child);
    // A confirmed REFUND closes out its parent PEG_IN (REFUNDING -> REFUNDED).
    // Use the stable parentId column; fall back to the legacy id-suffix for rows
    // that predate the parentId column.
    if (t.status === "CONFIRMED" && rec.direction === "REFUND") {
      const parentId = rec.parentId ?? (rec.id.endsWith(":refund") ? rec.id.slice(0, -":refund".length) : null);
      if (parentId) await store.setStatus(parentId, "REFUNDED");
    }
    if (t.status === "REFUNDING") {
      notifyStaff("refund", `delivery window exhausted for ${rec.id}; refunding`, { id: rec.id, error: result.error });
    }
    console.log(
      `[dispatcher] ${rec.id} ${rec.direction} -> ${t.status}` +
        `${result.txid ? ` (${result.txid})` : ""}${result.error ? ` [${result.error}]` : ""}` +
        `${children.length ? ` +${children.map((c) => c.direction).join(",")}` : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = createStore(cfg.storeUrl);
  const url = cfg.coordinator.url;
  const opts = {
    retryIntervalMs: cfg.dispatcher.retryIntervalMs,
    windowMs: cfg.dispatcher.windowMs,
    signingTimeoutMs: cfg.dispatcher.signingTimeoutMs,
    staleDeliveryAlertMs: cfg.dispatcher.staleDeliveryAlertMs,
    feesGateAccount: cfg.feesGateAccount,
  };
  // Persists across ticks so a wedged row is alerted once, not every loop.
  const state = { alertedWedged: new Set<string>() };

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[dispatcher] coordinator=${url} interval=${cfg.dispatcher.intervalMs}ms window=${cfg.dispatcher.windowMs}ms`);

  while (running) {
    try {
      if (!(await store.isPaused())) await tick(store, url, opts, state);
    } catch (err) {
      console.error("[dispatcher] tick error:", err);
    }
    await new Promise((r) => setTimeout(r, cfg.dispatcher.intervalMs));
  }

  await store.close();
  console.log("[dispatcher] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
