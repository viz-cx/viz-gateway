import { buildGatewayAccounts, createStore, loadConfig } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
// Import the adapter MODULES directly (not the package entrypoints, which start
// the watcher loops on import).
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
import { SolanaChain, pubkeyOf } from "@gateway/solana-watcher/dist/solanaChain";
import { Recon } from "./checker";

export { Recon } from "./checker";

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
  const reconCfg = { ...cfg.recon, expectedRemotes: undefined };
  if (cfg.gram.jettonMinterAddress) {
    const gram = new GramHttpChain(
      cfg.gram.endpoint,
      cfg.gram.apiKey,
      cfg.gram.jettonMinterAddress,
      cfg.gram.gatewayJettonWallet,
      cfg.gram.multisigAddress,
      cfg.gram.finalityConfirmations,
    );
    recons.push(new Recon(
      [{ name: "GRAM", supply: () => gram.circulatingSupplyMilliViz() }],
      () => viz.gatewayBalanceMilliViz(accounts.accountFor("GRAM")),
      store,
      reconCfg,
      "GRAM",
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
    ));
  }
  // VG-02: no remotes = fatal misconfiguration (recon would always see circulating = 0).
  if (recons.length === 0) throw new Error("[recon] no remote configured — set GRAM_JETTON_MINTER_ADDRESS or SOLANA_WVIZ_MINT");

  const configuredChains = [cfg.gram.jettonMinterAddress && "GRAM", cfg.solana.wvizMint && "SOLANA"].filter(Boolean).join(",");
  const once = process.env.RECON_ONCE === "1";
  console.log(
    `[recon] interval=${cfg.recon.intervalMs}ms tolerance=${cfg.recon.driftToleranceMilliViz} mVIZ maxConsecFail=${cfg.recon.maxConsecutiveFailures} chains=[${configuredChains}] once=${once}`,
  );

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
