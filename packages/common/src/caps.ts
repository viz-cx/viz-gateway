// Caps and circuit breakers. Policy is intentionally simple and conservative.
// All amounts are integer milli-VIZ (1 VIZ = 1000).

export interface CapPolicy {
  perTxMilliViz: bigint;
  rolling24hMilliViz: bigint;
  manualReviewAboveMilliViz: bigint;
}

export type CapDecision =
  | { ok: true }
  | { ok: false; reason: "OVER_PER_TX" | "OVER_24H" | "PAUSED" }
  | { ok: false; reason: "NEEDS_MANUAL_REVIEW" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tracks a rolling 24h sum and enforces caps + a global pause flag. */
export class CircuitBreaker {
  private readonly policy: CapPolicy;
  private readonly window: Array<{ ts: number; amount: bigint }> = [];
  private paused = false;
  private pausedReason = "";

  constructor(policy: CapPolicy) {
    this.policy = policy;
  }

  /** 1-of-N: any operator may pause. Unpause requires deliberate T-of-N action. */
  pause(reason: string): void {
    this.paused = true;
    this.pausedReason = reason;
  }

  unpause(): void {
    this.paused = false;
    this.pausedReason = "";
  }

  isPaused(): boolean {
    return this.paused;
  }

  reason(): string {
    return this.pausedReason;
  }

  private rollingSum(now: number): bigint {
    const cutoff = now - DAY_MS;
    while (this.window.length > 0 && this.window[0]!.ts < cutoff) {
      this.window.shift();
    }
    return this.window.reduce((acc, e) => acc + e.amount, 0n);
  }

  /** Evaluate a candidate transfer without recording it. */
  check(amount: bigint, now: number = Date.now()): CapDecision {
    if (this.paused) return { ok: false, reason: "PAUSED" };
    if (amount > this.policy.perTxMilliViz) return { ok: false, reason: "OVER_PER_TX" };
    if (this.rollingSum(now) + amount > this.policy.rolling24hMilliViz) {
      return { ok: false, reason: "OVER_24H" };
    }
    if (amount > this.policy.manualReviewAboveMilliViz) {
      return { ok: false, reason: "NEEDS_MANUAL_REVIEW" };
    }
    return { ok: true };
  }

  /** Record an accepted transfer into the rolling window. */
  record(amount: bigint, now: number = Date.now()): void {
    this.window.push({ ts: now, amount });
  }
}
