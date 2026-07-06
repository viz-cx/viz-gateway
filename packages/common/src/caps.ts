// Caps and circuit breakers. Policy is intentionally simple and conservative.
// All amounts are integer milli-VIZ (1 VIZ = 1000).
//
// The rolling 24h window lives in the shared GatewayStore (sqlite), so the cap is
// global across processes AND survives a restart (the old in-memory window reset
// to empty on restart, which let the daily cap be bypassed by restarting).

import type { GatewayStore } from "./store";

export interface CapPolicy {
  perTxMilliViz: bigint;
  rolling24hMilliViz: bigint;
  manualReviewAboveMilliViz: bigint;
}

export type CapDecision =
  | { ok: true }
  | { ok: false; reason: "OVER_PER_TX" | "OVER_24H" | "NEEDS_MANUAL_REVIEW" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Enforces per-tx / rolling-24h / manual-review caps against the shared window. */
export class CircuitBreaker {
  constructor(
    private readonly policy: CapPolicy,
    private readonly store: GatewayStore,
  ) {}

  /** Evaluate a candidate transfer without recording it. */
  async check(amount: bigint, now: number = Date.now()): Promise<CapDecision> {
    if (amount > this.policy.perTxMilliViz) return { ok: false, reason: "OVER_PER_TX" };
    const sum = await this.store.capSumMilliViz(now - DAY_MS, now);
    if (sum + amount > this.policy.rolling24hMilliViz) return { ok: false, reason: "OVER_24H" };
    if (amount > this.policy.manualReviewAboveMilliViz) return { ok: false, reason: "NEEDS_MANUAL_REVIEW" };
    return { ok: true };
  }

  /** Record an accepted transfer into the shared rolling window. */
  async record(amount: bigint, now: number = Date.now()): Promise<void> {
    await this.store.recordCap(amount, now);
  }

  /**
   * Atomic evaluate-and-record: the correct primitive when the caller will act on `ok`. The
   * per-tx and manual-review gates are pure per-amount checks (no window state), so they run
   * first; the rolling-24h check and its record then happen in ONE atomic store transaction
   * (tryReserveCap). This closes the cross-process TOCTOU the separate check()+record() pair had,
   * where two watchers could both pass check() and both record() over the cap while neither
   * tripped the OVER_24H pause. Nothing is recorded unless the decision is `ok`.
   */
  async checkAndRecord(amount: bigint, now: number = Date.now()): Promise<CapDecision> {
    if (amount > this.policy.perTxMilliViz) return { ok: false, reason: "OVER_PER_TX" };
    if (amount > this.policy.manualReviewAboveMilliViz) return { ok: false, reason: "NEEDS_MANUAL_REVIEW" };
    const reserved = await this.store.tryReserveCap(amount, this.policy.rolling24hMilliViz, now - DAY_MS, now);
    if (!reserved) return { ok: false, reason: "OVER_24H" };
    return { ok: true };
  }
}
