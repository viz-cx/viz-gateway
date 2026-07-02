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
 *  - broadcast success            -> CONFIRMED (and the PEG_IN fee is pinned onto
 *                                    the row so unsweptFeesMilliViz() can see it)
 *  - failure, still within window -> QUEUED again with backoff (retry)
 *  - failure, window exhausted    -> for a PEG_IN: REFUNDING (the dispatcher spawns
 *                                    a REFUND child that returns gross to the sender,
 *                                    itself a T-of-N transfer). For a PEG_OUT /
 *                                    FEE_SWEEP / REFUND there is nothing to refund —
 *                                    the gateway already owes that release — so we
 *                                    keep retrying (QUEUED) until the federation can
 *                                    sign it, rather than dead-ending the row.
 *
 * The 3-min window matches "try consensus, else refund" for inbound deposits. A
 * genuinely degraded federation keeps retrying the release/refund until it recovers.
 */
export function planTransition(rec: OutboxRecord, result: DeliveryResult, now: number, opts: RetryOpts): Transition {
  if (result.broadcast) {
    // Pin the withheld fee onto a PEG_IN row, but only a POSITIVE one: on the recovery
    // path the coordinator may report fee 0 (rebuild failed), which must not clobber a
    // fee it already pinned via store.setFee. undefined -> COALESCE leaves the column.
    const feeMilliViz = result.feeMilliViz && result.feeMilliViz > 0n ? result.feeMilliViz : undefined;
    return { status: "CONFIRMED", patch: { txid: result.txid ?? null, lastError: null, feeMilliViz } };
  }
  const attempts = rec.attempts + 1;
  const error = result.error ?? "delivery failed";
  const nextAttemptAt = now + opts.retryIntervalMs;
  if (now - rec.createdAt >= opts.windowMs && rec.direction === "PEG_IN") {
    return { status: "REFUNDING", patch: { attempts, lastError: `window exhausted: ${error}`, nextAttemptAt } };
  }
  return { status: "QUEUED", patch: { attempts, lastError: error, nextAttemptAt } };
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
        parentId: rec.id,
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
        parentId: rec.id,
      },
    ];
  }
  return [];
}
