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
  opts: { retryIntervalMs: number; windowMs: number; signingTimeoutMs: number; feesGateAccount: string },
): Promise<void> {
  const now = Date.now();
  // Recover orphaned SIGNING rows: a crash between marking a row SIGNING and
  // recording its transition would otherwise strand it forever (due() only scans
  // QUEUED). Any row SIGNING longer than signingTimeoutMs (> the worst-case
  // coordinator round-trip) is requeued for another attempt.
  const orphaned = await store.stale(now, opts.signingTimeoutMs, ["SIGNING"]);
  for (const rec of orphaned) {
    await store.setStatus(rec.id, "QUEUED", { nextAttemptAt: now });
    console.warn(`[dispatcher] recovered orphaned SIGNING row ${rec.id} -> QUEUED`);
  }

  // Deliver every QUEUED row (PEG_IN mints; PEG_OUT/FEE_SWEEP/REFUND are VIZ releases).
  const due = await store.due(now, ["QUEUED"]);
  for (const rec of due) {
    await store.setStatus(rec.id, "SIGNING");
    const result = await submit(url, rec);
    const t = planTransition(rec, result, Date.now(), opts);
    await store.setStatus(rec.id, t.status, t.patch);
    // Spawn FEE_SWEEP (on confirm) or REFUND (on window-exhaust) for a PEG_IN.
    const children = planChildren(rec, t.status, {
      feesGateAccount: opts.feesGateAccount,
      feeMilliViz: result.feeMilliViz ?? 0n,
    });
    for (const child of children) await store.enqueue(child);
    // A confirmed REFUND closes out its parent PEG_IN (REFUNDING -> REFUNDED), the
    // terminal state the status machine documents but nothing set before.
    if (t.status === "CONFIRMED" && rec.direction === "REFUND" && rec.id.endsWith(":refund")) {
      await store.setStatus(rec.id.slice(0, -":refund".length), "REFUNDED");
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
    feesGateAccount: cfg.feesGateAccount,
  };

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[dispatcher] coordinator=${url} interval=${cfg.dispatcher.intervalMs}ms window=${cfg.dispatcher.windowMs}ms`);

  while (running) {
    try {
      if (!(await store.isPaused())) await tick(store, url, opts);
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
