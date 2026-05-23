import type { Approval } from "./types";

/**
 * Threshold accumulation. The coordinator (or any operator) collects approvals
 * for a given action digest and can broadcast only once T distinct, valid
 * operator approvals exist. This module does NOT verify signatures (that needs
 * the chain-specific verifier); it enforces distinctness and the count.
 */
export class ApprovalSet {
  private readonly threshold: number;
  private readonly knownOperators: Set<string>;
  private readonly byAction = new Map<string, Map<string, Approval>>();

  constructor(threshold: number, operators: string[]) {
    this.threshold = threshold;
    this.knownOperators = new Set(operators);
  }

  /** Add an approval. Returns true if accepted (new, from a known operator). */
  add(a: Approval): boolean {
    if (!this.knownOperators.has(a.operatorId)) return false;
    let set = this.byAction.get(a.actionId);
    if (!set) {
      set = new Map();
      this.byAction.set(a.actionId, set);
    }
    if (set.has(a.operatorId)) return false; // one approval per operator
    set.set(a.operatorId, a);
    return true;
  }

  count(actionId: string): number {
    return this.byAction.get(actionId)?.size ?? 0;
  }

  isMet(actionId: string): boolean {
    return this.count(actionId) >= this.threshold;
  }

  approvals(actionId: string): Approval[] {
    return Array.from(this.byAction.get(actionId)?.values() ?? []);
  }
}

/** Pure helper: tolerances for an N/T config (mirrors tools/threshold-calc.mjs). */
export function tolerances(n: number, t: number): {
  theftTolerated: number;
  freezeTolerated: number;
  bftFaultBudget: number;
} {
  return {
    theftTolerated: t - 1,
    freezeTolerated: n - t,
    bftFaultBudget: Math.min(t - 1, n - t),
  };
}
