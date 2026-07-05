import type { GatewayStore } from "@gateway/common";
import { notifyStaff } from "@gateway/log";

export interface ReconCfg {
  driftToleranceMilliViz: bigint;
  maxConsecutiveFailures: number;
  /**
   * Chain names that MUST be present as remotes (e.g. ["TON","SOLANA"]). If any is
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
  ) {
    // VG-02: zero remotes is a fatal misconfiguration — recon with no wVIZ supply
    // visibility always sees circulating = 0, so drift ≥ 0, so always "healthy".
    if (remotes.length === 0) {
      throw new Error(
        "[recon] no remote chain configured — configure at least one of " +
          "TON_JETTON_MINTER_ADDRESS / SOLANA_WVIZ_MINT. " +
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
        this.store.unsweptFeesMilliViz(),
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
