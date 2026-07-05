import type { CircuitBreaker } from "./caps";
import type { OutboxRecord } from "./idempotency";
import type { GatewayStore } from "./store";

export interface SeenRecoveryOutcome {
  /** Rows advanced SEEN -> QUEUED (cap ok). */
  requeued: OutboxRecord[];
  /** Rows moved SEEN -> HELD (cap rejected). */
  held: OutboxRecord[];
  /** An OVER_24H hold paused the gateway. */
  paused: boolean;
}

/**
 * Recover actions orphaned in SEEN (VG M6).
 *
 * A detection-path watcher writes the row SEEN, then runs the cap check and advances it to
 * QUEUED. An exception in between (SQLITE_BUSY, a pause flip, a record error) strands the row
 * in SEEN forever: the re-scan sees enqueue() return false and `continue`s, and the dispatcher
 * only ever looks at QUEUED/BROADCAST — so the mint/release silently never happens even though
 * the funds are safe. This is safe to auto-recover ONLY for detection paths (viz-watcher peg-in,
 * gram-watcher peg-out), where the source event was already final on-chain BEFORE the enqueue —
 * NOT for the execute path (pegoutScanner burns AFTER claiming, so it must first check the burn).
 *
 * For each SEEN row older than `staleMs` matching `match`, re-run the SAME cap decision and
 * advance it, exactly as the live path would have. The caller alerts staff on the outcome.
 *
 * Cap note: if the crash landed AFTER the cap was recorded, re-running checkAndRecord counts
 * the amount twice — conservative (caps only get stricter: an early HELD/pause, never a bypass)
 * and confined to the rare crash window.
 */
export async function recoverStaleSeen(
  store: GatewayStore,
  breaker: CircuitBreaker,
  opts: { now: number; staleMs: number; match: (r: OutboxRecord) => boolean; capPauseReason: string },
): Promise<SeenRecoveryOutcome> {
  const out: SeenRecoveryOutcome = { requeued: [], held: [], paused: false };
  for (const rec of await store.stale(opts.now, opts.staleMs, ["SEEN"])) {
    if (!opts.match(rec)) continue;
    const decision = await breaker.checkAndRecord(rec.amountMilliViz);
    if (!decision.ok) {
      await store.setStatus(rec.id, "HELD", { lastError: decision.reason });
      out.held.push(rec);
      if (decision.reason === "OVER_24H") {
        await store.pause(opts.capPauseReason);
        out.paused = true;
      }
      continue;
    }
    await store.setStatus(rec.id, "QUEUED");
    out.requeued.push(rec);
  }
  return out;
}
