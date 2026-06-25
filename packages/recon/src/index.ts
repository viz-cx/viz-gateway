import { createStore, loadConfig } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
// Import the adapter MODULES directly (not the package entrypoints, which start
// the watcher loops on import).
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";
import { SolanaChain, pubkeyOf } from "@gateway/solana-watcher/dist/solanaChain";

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
  const viz = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
  // Sum circulating wVIZ across EVERY configured remote chain — a single-remote
  // recon would mask an over-mint on the other chain (§6.2).
  const remotes: Array<{ name: string; supply: () => Promise<bigint> }> = [];
  if (cfg.ton.jettonMinterAddress) {
    const ton = new TonHttpChain(
      cfg.ton.endpoint,
      cfg.ton.apiKey,
      cfg.ton.jettonMinterAddress,
      cfg.ton.gatewayJettonWallet,
      cfg.ton.finalityConfirmations,
    );
    remotes.push({ name: "TON", supply: () => ton.circulatingSupplyMilliViz() });
  }
  if (cfg.solana.wvizMint) {
    const sol = new SolanaChain(cfg.solana.rpcUrl, cfg.solana.wvizMint, cfg.solana.gatewayTokenAccount, cfg.solana.finalitySlots);
    remotes.push({ name: "SOLANA", supply: () => sol.circulatingSupplyMilliViz() });
  }
  if (remotes.length === 0) {
    console.warn("[recon] no remote chain configured; circulating supply treated as 0 until configured.");
  }

  const store = createStore(cfg.storeUrl);
  const once = process.env.RECON_ONCE === "1";
  console.log(
    `[recon] interval=${cfg.recon.intervalMs}ms tolerance=${cfg.recon.driftToleranceMilliViz} mVIZ remotes=[${remotes.map((r) => r.name).join(",")}] once=${once}`,
  );

  const check = async (): Promise<boolean> => {
    const [locked, supplies, unsweptFees] = await Promise.all([
      viz.gatewayBalanceMilliViz(),
      Promise.all(remotes.map((r) => r.supply())),
      store.unsweptFeesMilliViz(),
    ]);
    const circulating = supplies.reduce((a, s) => a + s, 0n);
    // Per-peg-in fee sweep keeps locked == circulating; between mint and FEE_SWEEP
    // the fee sits as surplus VIZ, so expected = circulating + unswept fees.
    const expectedLocked = circulating + unsweptFees;
    const drift = locked - expectedLocked;
    // Safe direction is over-backing (locked > expected). Under-backing
    // (circulating > locked, i.e. drift < −tolerance) is always CRITICAL.
    const ok = drift >= -cfg.recon.driftToleranceMilliViz;
    console.log(
      `[recon] locked=${locked} circulating=${circulating} unsweptFees=${unsweptFees} drift=${drift} status=${ok ? "OK" : "UNDER-BACKED"}`,
    );
    if (!ok) {
      // Trip the shared, cross-process global pause. All watchers/signers see it.
      // Clearing it is a deliberate T-of-N operator action (unpause), never automatic.
      const reason = `under-backing ${drift} mVIZ (locked=${locked}, circulating=${circulating}, unsweptFees=${unsweptFees})`;
      await store.pause(reason);
      console.error(`[recon] CRITICAL: UNDER-BACKING DETECTED -> gateway paused: ${reason}`);
      notifyStaff("drift", reason, { locked: String(locked), circulating: String(circulating) });
    }
    return ok;
  };

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
    const ok = await check();
    await reserveCheck();
    await store.close();
    process.exit(ok ? 0 : 2);
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      await check();
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
