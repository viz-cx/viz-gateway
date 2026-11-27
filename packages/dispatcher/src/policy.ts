import type { ActionStatus, EnqueueInput, OutboxRecord, StatusPatch } from "@gateway/common";

/** Outcome of asking the coordinator to orchestrate one action. */
export interface DeliveryResult {
  /** The coordinator broadcast the action (threshold met). */
  broadcast: boolean;
  txid?: string;
  /** Fee withheld for a PEG_IN (so the dispatcher can spawn the FEE_SWEEP). */
  feeMilliViz?: bigint;
  error?: string;
  /**
   * The coordinator gave no verdict (transport error / proxy timeout / non-2xx / paused): the
   * orchestration may STILL be running and land the mint. Never refund on this — retry, so the
   * next round's actionExecuted check sees a landed mint instead of paying it out twice.
   */
  indeterminate?: boolean;
}

/**
 * Map the coordinator's /submit HTTP response to a DeliveryResult (pure, testable).
 *
 * Only a 200 JSON body is a VERDICT: the orchestrator reached it after its own actionExecuted
 * check said "not on-chain", so a `broadcast:false` there is safe to count toward a refund.
 * Everything else is INDETERMINATE — a proxy 502/504 (the coordinator may still be minting), a
 * 423 pause, a 401, or a coordinator 500 (its actionExecuted read itself failed, so nobody
 * checked whether an earlier round's mint landed). A garbled 200 is indeterminate too, and so
 * is a 200 whose approvals reached the threshold without a confirmed broadcast.
 */
export function deliveryResultFrom(status: number, bodyText: string): DeliveryResult {
  const noVerdict = (error: string): DeliveryResult => ({ broadcast: false, error, indeterminate: true });
  if (status === 423) return noVerdict("coordinator paused");
  if (status !== 200) return noVerdict(`coordinator HTTP ${status}`);
  let body: { broadcast?: unknown; txid?: unknown; error?: unknown; feeMilliViz?: unknown; approvals?: unknown; threshold?: unknown };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    return noVerdict("coordinator returned a non-JSON 200");
  }
  if (body === null || typeof body !== "object" || typeof body.broadcast !== "boolean") {
    return noVerdict("coordinator 200 carries no broadcast verdict");
  }
  // Threshold met but not confirmed (TON order "not executed in time", Solana send error): the
  // authorization is COMPLETE and may still land — a durable-nonce tx never expires. Not a
  // refundable failure; retry until the coordinator's on-chain check settles it.
  if (
    !body.broadcast &&
    typeof body.approvals === "number" &&
    typeof body.threshold === "number" &&
    body.approvals >= body.threshold
  ) {
    return noVerdict(`threshold met but not confirmed: ${typeof body.error === "string" ? body.error : "no error"}`);
  }
  // An unparseable fee must not turn a landed mint into a failure: the coordinator already
  // pinned the real fee on the row, so drop it here and let COALESCE keep the pinned value.
  let feeMilliViz: bigint | undefined;
  try {
    feeMilliViz = body.feeMilliViz !== undefined ? BigInt(String(body.feeMilliViz)) : undefined;
  } catch {
    feeMilliViz = undefined;
  }
  return {
    broadcast: body.broadcast,
    txid: typeof body.txid === "string" ? body.txid : undefined,
    feeMilliViz,
    error: typeof body.error === "string" ? body.error : undefined,
  };
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
 *                                    a REFUND child that returns gross − refund fee to the
 *                                    sender, itself a T-of-N transfer). For a PEG_OUT /
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
  // Refund only on a DEFINITIVE coordinator failure, and never on a row's first verdict: an aged
  // row (backlog / post-unpause) must get one re-drive, whose actionExecuted check catches a mint
  // that landed after the previous round gave up. Signers do not check mint-vs-refund themselves.
  const mayRefund = !result.indeterminate && rec.attempts > 0;
  if (now - rec.createdAt >= opts.windowMs && rec.direction === "PEG_IN" && mayRefund) {
    return { status: "REFUNDING", patch: { attempts, lastError: `window exhausted: ${error}`, nextAttemptAt } };
  }
  return { status: "QUEUED", patch: { attempts, lastError: error, nextAttemptAt } };
}

/**
 * Child actions spawned by a parent's transition (pure, testable):
 *   - PEG_IN CONFIRMED  -> FEE_SWEEP: sweep the `base` fee to fees.gate (a VIZ
 *     transfer from the M-of-N account, so it rides the release path as a PEG_OUT).
 *   - PEG_IN REFUNDING  -> REFUND: return GROSS to the original VIZ sender.
 * Both are idempotent (deterministic child id) and re-use the outbox + dispatcher.
 *
 * VG-04: the swept amount is `ctx.sweepAmountMilliViz` — the independently-derived `base`
 * fee (a pure function of the immutable gross), NOT the coordinator-pinned withheld fee.
 * Any activation surcharge withheld at mint is deliberately retained on the gateway as
 * backing surplus (the signer only signs a sweep for exactly `base`); this matches the
 * signer's validateFeeSweep exact check and removes all coordinator discretion over the
 * sweep. The withheld fee (base + activation) stays pinned on the row for recon accounting.
 */
/** Refund = gross minus the fixed refund fee, floored at 0 (dust is retained as surplus). */
export function refundAmount(gross: bigint, refundFee: bigint): bigint {
  const r = gross - refundFee;
  return r > 0n ? r : 0n;
}

export function planChildren(
  rec: OutboxRecord,
  status: ActionStatus,
  ctx: { feesGateAccount: string; sweepAmountMilliViz: bigint; refundFeeMilliViz: bigint },
): EnqueueInput[] {
  if (status === "CONFIRMED" && rec.direction === "PEG_IN" && ctx.sweepAmountMilliViz > 0n) {
    return [
      {
        id: `${rec.id}:fee`,
        direction: "FEE_SWEEP",
        remoteChain: rec.remoteChain,
        recipient: ctx.feesGateAccount,
        amountMilliViz: ctx.sweepAmountMilliViz,
        digest: `${rec.digest}:fee`,
        status: "QUEUED",
        parentId: rec.id,
      },
    ];
  }
  if (status === "REFUNDING" && rec.direction === "PEG_IN" && rec.sender) {
    const amt = refundAmount(rec.amountMilliViz, ctx.refundFeeMilliViz);
    if (amt === 0n) return []; // dust: nothing worth refunding; retained as gateway surplus
    return [
      {
        id: `${rec.id}:refund`,
        direction: "REFUND",
        remoteChain: rec.remoteChain,
        recipient: rec.sender, // back to the VIZ sender
        amountMilliViz: amt, // gross − refund fee
        digest: `${rec.digest}:refund`,
        status: "QUEUED",
        parentId: rec.id,
      },
    ];
  }
  if (
    status === "REFUNDING" &&
    rec.direction === "PEG_OUT" &&
    rec.lastError === "RETURN_INVALID_DEST" &&
    rec.sender
  ) {
    const amt = refundAmount(rec.amountMilliViz, ctx.refundFeeMilliViz);
    if (amt === 0n) return []; // dust: wVIZ <= refund fee, retained as gateway surplus
    return [
      {
        id: `${rec.id}:return`,
        direction: "GRAM_RETURN",
        remoteChain: rec.remoteChain,
        recipient: rec.sender, // original TON sender
        amountMilliViz: amt, // gross − refund fee
        digest: `${rec.digest}:return`,
        status: "QUEUED",
        parentId: rec.id,
      },
    ];
  }
  return [];
}
