import { buildGatewayAccounts, createStore, loadConfig, pegInFeePolicyFor } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
// Import the adapter MODULES directly (not the package entrypoints, which start
// the watcher loops on import).
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
import { SolanaChain, pubkeyOf } from "@gateway/solana-watcher/dist/solanaChain";
import { Recon, uncoveredActiveChains } from "./checker";

export { Recon, uncoveredActiveChains } from "./checker";

/**
 * recon: continuously checks the peg invariant
 *     locked VIZ (gateway balance)  ==  circulating wVIZ (summed over all remotes)
 *                                        + fees minted-but-not-yet-swept
 * Under-backing (circulating > locked) is CRITICAL and trips the shared pause;
 * over-backing (unswept fee surplus) is the safe direction. Also monitors the
 * Solana submitter's SOL reserve (it pays fee + ATA rent per mint).
 *
 * Set RECON_ONCE=1 to run a single check and exit (cron / smoke test).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const accounts = buildGatewayAccounts(cfg);
  const viz = new VizJsChain(cfg.viz.nodeUrl, accounts);
  // One Recon per chain: each checks locked(accountₖ) ≥ circulating(k) + unsweptFees(k).
  // A per-chain split prevents a surplus on one chain from masking under-backing on another.
  const store = createStore(cfg.storeUrl);
  const recons: Recon[] = [];
  // The chains recon actually covers (one Recon each). Derived from config, reused by both the
  // static VG-02 gate and the store-derived M9 gate below.
  const coveredChains = new Set<string>();
  if (cfg.gram.jettonMinterAddress) coveredChains.add("GRAM");
  if (cfg.solana.wvizMint) coveredChains.add("SOLANA");
  // VG-02: validate that every chain in RECON_EXPECTED_REMOTES is actually configured.
  // The per-chain Recon constructor can't catch "GRAM expected but no GRAM_JETTON_MINTER_ADDRESS
  // set" because that Recon is never even created in that case.
  if (cfg.recon.expectedRemotes && cfg.recon.expectedRemotes.length > 0) {
    const missing = cfg.recon.expectedRemotes.filter((c) => !coveredChains.has(c));
    if (missing.length > 0) {
      throw new Error(
        `[recon] expected remote(s) [${missing.join(",")}] not configured ` +
          `(present: [${[...coveredChains].join(",")}]). ` +
          `A remote with live wVIZ must never drop out of recon. Fix config or update RECON_EXPECTED_REMOTES.`,
      );
    }
  }
  const reconCfg = { ...cfg.recon, expectedRemotes: undefined };
  if (cfg.gram.jettonMinterAddress) {
    const gram = new GramHttpChain(
      cfg.gram.endpoint,
      cfg.gram.apiKey,
      cfg.gram.jettonMinterAddress,
      cfg.gram.gatewayJettonWallet,
      cfg.gram.multisigAddress,
      cfg.gram.finalityConfirmations,
      cfg.gram.scanMaxTransactions,
      cfg.gram.maxScanPages,
      cfg.gram.rpcTimeoutMs,
    );
    recons.push(new Recon(
      [{ name: "GRAM", supply: () => gram.circulatingSupplyMilliViz() }],
      () => viz.gatewayBalanceMilliViz(accounts.accountFor("GRAM")),
      store,
      reconCfg,
      "GRAM",
      pegInFeePolicyFor(cfg.fees, "GRAM"), // recon derives unswept fees from gross, not the pinned fee
    ));
  }
  if (cfg.solana.wvizMint) {
    const sol = new SolanaChain(cfg.solana.rpcUrl, cfg.solana.wvizMint, cfg.solana.gatewayTokenAccount, cfg.solana.finalitySlots);
    recons.push(new Recon(
      [{ name: "SOLANA", supply: () => sol.circulatingSupplyMilliViz() }],
      () => viz.gatewayBalanceMilliViz(accounts.accountFor("SOLANA")),
      store,
      reconCfg,
      "SOLANA",
      pegInFeePolicyFor(cfg.fees, "SOLANA"), // recon derives unswept fees from gross, not the pinned fee
    ));
  }
  // VG-02: no remotes = fatal misconfiguration (recon would always see circulating = 0).
  if (recons.length === 0) throw new Error("[recon] no remote configured — set GRAM_JETTON_MINTER_ADDRESS or SOLANA_WVIZ_MINT");

  const once = process.env.RECON_ONCE === "1";
  console.log(
    `[recon] interval=${cfg.recon.intervalMs}ms tolerance=${cfg.recon.driftToleranceMilliViz} mVIZ maxConsecFail=${cfg.recon.maxConsecutiveFailures} chains=[${[...coveredChains].join(",")}] once=${once}`,
  );

  // M9: recon must cover EVERY chain that has minted (or committed to minting) wVIZ. Unlike
  // RECON_EXPECTED_REMOTES (an env that defaults empty → fail-OPEN when a live chain is dropped),
  // the active set is derived from the durable outbox: any chain with a committed/minted PEG_IN.
  // A chain that minted wVIZ but has no Recon is a silent per-chain fail-open — its backing goes
  // unchecked while circulating wVIZ still exists. Fail closed: pause the whole gateway + alert.
  // Fatal at startup (refuse to run half-covered); in the loop, pause+alert but keep monitoring the
  // covered chains rather than crashing recon entirely (which would stop all checking).
  // Dedup the coverage alert: the loop re-checks every tick, so without this an uncovered
  // active chain would page staff + re-log CRITICAL on every interval (alert storm) until
  // fixed. Alert once on transition into an uncovered state (or when the uncovered set
  // changes), and reset when coverage is restored so a later regression re-alerts. The
  // pause is left as-is: store.pause() is idempotent and must persist while uncovered.
  let lastCoverageAlert = "";
  const enforceActiveChainCoverage = async (fatal: boolean): Promise<void> => {
    const uncovered = uncoveredActiveChains(await store.activeRemoteChains(), coveredChains);
    if (uncovered.length === 0) {
      lastCoverageAlert = "";
      return;
    }
    const reason =
      `[recon] active chain(s) [${uncovered.join(",")}] have minted wVIZ but are not covered by recon ` +
      `(covered: [${[...coveredChains].join(",")}]). A chain with live circulating wVIZ must never drop out ` +
      `of recon — restore its config (GRAM_JETTON_MINTER_ADDRESS / SOLANA_WVIZ_MINT).`;
    await store.pause(reason);
    const signature = [...uncovered].sort().join(",");
    if (signature !== lastCoverageAlert) {
      lastCoverageAlert = signature;
      console.error(`[recon] CRITICAL: ${reason}`);
      notifyStaff("recon", reason, { uncovered, covered: [...coveredChains] });
    }
    if (fatal) throw new Error(reason);
  };
  await enforceActiveChainCoverage(true);

  // D3 reserve monitor: the Solana submitter pays fee + ATA rent for every mint;
  // if it runs dry, mints silently fail. Page (don't pause) when it's low.
  const submitter =
    cfg.solana.wvizMint && cfg.solana.submitterSecret ? pubkeyOf(cfg.solana.submitterSecret) : null;
  const reserveCheck = async (): Promise<void> => {
    if (!submitter) return;
    try {
      const sol = new SolanaChain(cfg.solana.rpcUrl, cfg.solana.wvizMint, cfg.solana.gatewayTokenAccount, cfg.solana.finalitySlots);
      const lamports = await sol.solBalanceLamports(submitter);
      if (lamports < cfg.solana.submitterMinLamports) {
        notifyStaff("reserve", `Solana submitter ${submitter} low: ${lamports} lamports < ${cfg.solana.submitterMinLamports}`, {
          lamports,
          floor: cfg.solana.submitterMinLamports,
        });
      }
    } catch (err) {
      console.warn("[recon] reserve check failed:", err);
    }
  };

  if (once) {
    const results = await Promise.all(recons.map((r) => r.check()));
    await reserveCheck();
    await store.close();
    // exit 0 = all chains healthy; exit 2 = any chain under-backed or indeterminate.
    process.exit(results.every((r) => r === true) ? 0 : 2);
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      // Re-check coverage each tick: a chain could go active at runtime (a peg-in mints on a chain
      // recon isn't wired for). Non-fatal here — pause+alert but keep checking the covered chains.
      await enforceActiveChainCoverage(false);
      for (const r of recons) {
        await r.onCheckResult(await r.check());
      }
      await reserveCheck();
    } catch (err) {
      console.error("[recon] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, cfg.recon.intervalMs));
  }

  await store.close();
  console.log("[recon] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
