import type { ActionStatus, EnqueueInput, OutboxRecord, StatusPatch } from "@gateway/common";

/** Outcome of asking the coordinator to orchestrate one action. */
export interface DeliveryResult {
  /** The coordinator broadcast the action (threshold met). */
  broadcast: boolean;
  txid?: string;
  /** Fee withheld for a PEG_IN (so the dispatcher can spawn the FEE_SWEEP). */
  feeMilliViz?: bigint;
  error?: string;
}

/** The next outbox state for a row after a delivery attempt. */
export interface Transition {
  status: ActionStatus;
  patch: StatusPatch;
}

export interface RetryOpts {
  /** Backoff between attempts (P3: 10s). */
  retryIntervalMs: number;
  /** Total delivery window before giving up and refunding (P3: 3 min). */
  windowMs: number;
}

/**
 * Pure transition policy for a delivered action (no I/O, fully testable).
 *
 *  - broadcast success            -> CONFIRMED
 *  - failure, still within window -> QUEUED again with backoff (retry)
 *  - failure, window exhausted    -> REFUNDING (the coordinator then returns gross
 *                                    to the sender; itself a T-of-N transfer)
 *
 * The 3-min window matches "try consensus, else refund". Refund is also T-of-N,
 * so a genuinely degraded federation stays in REFUNDING until it recovers; only
 * an unrecoverable refund becomes terminal FAILED (handled by the refund path).
 */
export function planTransition(rec: OutboxRecord, result: DeliveryResult, now: number, opts: RetryOpts): Transition {
  if (result.broadcast) {
    return { status: "CONFIRMED", patch: { txid: result.txid ?? null, lastError: null } };
  }
  const attempts = rec.attempts + 1;
  const error = result.error ?? "delivery failed";
  if (now - rec.createdAt >= opts.windowMs) {
    return { status: "REFUNDING", patch: { attempts, lastError: `window exhausted: ${error}`, nextAttemptAt: now + opts.retryIntervalMs } };
  }
  return { status: "QUEUED", patch: { attempts, lastError: error, nextAttemptAt: now + opts.retryIntervalMs } };
}

/**
 * Child actions spawned by a parent's transition (pure, testable):
 *   - PEG_IN CONFIRMED  -> FEE_SWEEP: move the withheld fee to fees.gate (a VIZ
 *     transfer from the M-of-N account, so it rides the release path as a PEG_OUT).
 *   - PEG_IN REFUNDING  -> REFUND: return GROSS to the original VIZ sender.
 * Both are idempotent (deterministic child id) and re-use the outbox + dispatcher.
 */
export function planChildren(
  rec: OutboxRecord,
  status: ActionStatus,
  ctx: { feesGateAccount: string; feeMilliViz: bigint },
): EnqueueInput[] {
  if (status === "CONFIRMED" && rec.direction === "PEG_IN" && ctx.feeMilliViz > 0n) {
    return [
      {
        id: `${rec.id}:fee`,
        direction: "FEE_SWEEP",
        recipient: ctx.feesGateAccount,
        amountMilliViz: ctx.feeMilliViz,
        digest: `${rec.digest}:fee`,
        status: "QUEUED",
      },
    ];
  }
  if (status === "REFUNDING" && rec.direction === "PEG_IN" && rec.sender) {
    return [
      {
        id: `${rec.id}:refund`,
        direction: "REFUND",
        recipient: rec.sender, // back to the VIZ sender
        amountMilliViz: rec.amountMilliViz, // gross (no fee on a refund)
        digest: `${rec.digest}:refund`,
        status: "QUEUED",
      },
    ];
  }
  return [];
}
