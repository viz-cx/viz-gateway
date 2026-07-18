import type { GatewayStore, RemoteChainId } from "@gateway/common";
import { notifyStaff } from "@gateway/log";

/** True iff the TON balance is under the configured floor. */
export function belowTonFloor(balanceNano: bigint, floorNano: number): boolean {
  return balanceNano < BigInt(floorNano);
}

export interface ReconCfg {
  driftToleranceMilliViz: bigint;
  maxConsecutiveFailures: number;
  /**
   * Chain names that MUST be present as remotes (e.g. ["GRAM","SOLANA"]). If any is
   * missing, the constructor throws. Closes the gap where dropping a remote's config
   * env var while it still has circulating wVIZ silently stops monitoring its supply
   * (the length===0 guard only catches ALL remotes missing, not a subset). Empty =
   * only the "at least one remote" guard applies.
   */
  expectedRemotes?: string[];
}

export interface RemoteChain {
  name: string;
  supply: () => Promise<bigint>;
}

/**
 * M9: given the chains that have live circulating wVIZ (from store.activeRemoteChains) and the
 * chains recon actually covers, return the active chains that are NOT covered. A non-empty result
 * means recon must fail closed (pause + refuse to run): a chain with live wVIZ has dropped out of
 * the peg-invariant check, so its backing is going unverified. Pure so the offline spike can assert
 * the exact decision main() uses (no drift).
 */
export function uncoveredActiveChains(active: readonly string[], covered: ReadonlySet<string>): string[] {
  return active.filter((c) => !covered.has(c));
}

/**
 * Encapsulates the recon peg-invariant check and consecutive-failure escalation.
 * Exported so the offline spike can instantiate it with fake remotes + store.
 */
export class Recon {
  consecutiveFailures = 0;

  constructor(
    private readonly remotes: RemoteChain[],
    private readonly getLockedBalance: () => Promise<bigint>,
    private readonly store: GatewayStore,
    private readonly cfg: ReconCfg,
    private readonly chain?: RemoteChainId,
    private readonly sanityFloorMilliViz?: bigint,
  ) {
    // VG-02: zero remotes is a fatal misconfiguration — recon with no wVIZ supply
    // visibility always sees circulating = 0, so drift ≥ 0, so always "healthy".
    if (remotes.length === 0) {
      throw new Error(
        "[recon] no remote chain configured — configure at least one of " +
          "GRAM_JETTON_MINTER_ADDRESS / SOLANA_WVIZ_MINT. " +
          "A recon with no supply visibility must not run.",
      );
    }
    // VG-follow-up (D): fail closed if an operator-declared remote is absent. Dropping a
    // remote's config while it still has circulating wVIZ would otherwise silently hide
    // that supply from the peg invariant (drift under-counts circulating → false "healthy").
    const present = new Set(remotes.map((r) => r.name));
    const missing = (cfg.expectedRemotes ?? []).filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(
        `[recon] expected remote(s) [${missing.join(",")}] missing from config ` +
          `(present: [${[...present].join(",")}]). A remote with live wVIZ must never drop out of recon. ` +
          `Fix the config or update RECON_EXPECTED_REMOTES.`,
      );
    }
  }

  /**
   * Run one peg-invariant check.
   * Returns true (OK), false (under-backed — gateway paused), or null (indeterminate
   * — one or more data sources unavailable; caller tracks consecutive failures).
   */
  async check(): Promise<boolean | null> {
    let locked: bigint;
    let unsweptFees: bigint;
    let settled: PromiseSettledResult<bigint>[];

    try {
      [locked, settled, unsweptFees] = await Promise.all([
        this.getLockedBalance(),
        Promise.allSettled(this.remotes.map((r) => r.supply())),
        this.store.unsweptFeesMilliViz(this.chain),
      ]);
    } catch (err) {
      console.error("[recon] check indeterminate (VIZ node or store unavailable):", err);
      return null;
    }

    const failedNames: string[] = [];
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") {
        const name = this.remotes[i]?.name ?? `remote[${i}]`;
        console.error(`[recon] supply unavailable for ${name}:`, s.reason);
        failedNames.push(name);
      }
    }
    if (failedNames.length > 0) {
      console.error(`[recon] check indeterminate (${failedNames.join(",")} supply unavailable) — not reporting healthy`);
      return null;
    }

    // Rate-independent sanity floor: a pinned fee grossly below the absolute mint-gas floor
    // signals a bug/mis-pin (recon trusts the pinned fee for backing, so guard its lower bound).
    if (this.sanityFloorMilliViz !== undefined) {
      const minFee = await this.store.minPegInFeeMilliViz(this.chain);
      if (minFee !== null && minFee < this.sanityFloorMilliViz) {
        const reason = `pinned PEG_IN fee ${minFee} mVIZ below sanity floor ${this.sanityFloorMilliViz} (${this.chain ?? "all"})`;
        await this.store.pause(reason);
        console.error(`[recon] CRITICAL: SANITY-FLOOR BREACH -> gateway paused: ${reason}`);
        notifyStaff("drift", reason, { minFee: String(minFee), floor: String(this.sanityFloorMilliViz) });
        return false;
      }
    }

    // Over-sweep guard (M10): a NEGATIVE unswept fee means confirmed FEE_SWEEPs pulled MORE
    // than the derived peg-in fees justify — mis-pinning or a double sweep leaking backing.
    // The store no longer clamps this to 0 (which silently hid it); treat it as a fail-closed
    // condition and pause, rather than folding a negative into the drift arithmetic.
    if (unsweptFees < 0n) {
      const reason = `over-swept fees ${unsweptFees} mVIZ: confirmed FEE_SWEEPs exceed derived peg-in fees (mis-pinning or double sweep)`;
      await this.store.pause(reason);
      console.error(`[recon] CRITICAL: OVER-SWEEP DETECTED -> gateway paused: ${reason}`);
      notifyStaff("drift", reason, { unsweptFees: String(unsweptFees) });
      return false;
    }

    const circulating = (settled as PromiseFulfilledResult<bigint>[]).reduce((a, s) => a + s.value, 0n);
    const expectedLocked = circulating + unsweptFees;
    const drift = locked - expectedLocked;
    const ok = drift >= -this.cfg.driftToleranceMilliViz;
    console.log(
      `[recon] locked=${locked} circulating=${circulating} unsweptFees=${unsweptFees} drift=${drift} status=${ok ? "OK" : "UNDER-BACKED"}`,
    );
    if (!ok) {
      const reason = `under-backing ${drift} mVIZ (locked=${locked}, circulating=${circulating}, unsweptFees=${unsweptFees})`;
      await this.store.pause(reason);
      console.error(`[recon] CRITICAL: UNDER-BACKING DETECTED -> gateway paused: ${reason}`);
      notifyStaff("drift", reason, { locked: String(locked), circulating: String(circulating) });
    }
    return ok;
  }

  /**
   * Handle the result of one check() call: reset the consecutive-failure counter on
   * any definitive result (OK or under-backed), increment on indeterminate, and pause
   * + alert when the threshold is reached.
   */
  async onCheckResult(result: boolean | null): Promise<void> {
    if (result === null) {
      this.consecutiveFailures++;
      console.warn(`[recon] check indeterminate (${this.consecutiveFailures}/${this.cfg.maxConsecutiveFailures} consecutive)`);
      if (this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) {
        const reason = `recon cannot verify backing (${this.consecutiveFailures} consecutive failures)`;
        await this.store.pause(reason);
        console.error(`[recon] CRITICAL: ${reason} -> gateway paused`);
        notifyStaff("recon-stalled", reason, { consecutiveFailures: String(this.consecutiveFailures) });
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }
}
