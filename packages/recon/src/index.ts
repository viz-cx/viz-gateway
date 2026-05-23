import { createStore, loadConfig } from "@gateway/common";
// Import the adapter MODULES directly (not the package entrypoints, which start
// the watcher loops on import).
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";

/**
 * recon: continuously checks the peg invariant
 *     locked VIZ (gateway account balance)  ==  circulating wVIZ (jetton supply)
 * Any drift beyond the dust tolerance is CRITICAL: peg-in/out must stop and
 * operators must be paged.
 *
 * Cross-process pause propagation goes through the shared store / coordinator
 * (the in-memory store here is per-process); wiring that flag is the one
 * remaining TODO. Computation and comparison below are live.
 *
 * Set RECON_ONCE=1 to run a single check and exit (cron / smoke test).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const viz = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
  const ton = cfg.ton.jettonMinterAddress
    ? new TonHttpChain(
        cfg.ton.endpoint,
        cfg.ton.apiKey,
        cfg.ton.jettonMinterAddress,
        cfg.ton.gatewayJettonWallet,
        cfg.ton.finalityConfirmations,
      )
    : null;

  if (!ton) {
    console.warn(
      "[recon] TON_JETTON_MINTER_ADDRESS unset; circulating supply treated as 0 until configured.",
    );
  }

  const store = createStore(cfg.storeUrl);
  const once = process.env.RECON_ONCE === "1";
  console.log(
    `[recon] interval=${cfg.recon.intervalMs}ms tolerance=${cfg.recon.driftToleranceMilliViz} mVIZ once=${once}`,
  );

  const check = async (): Promise<boolean> => {
    const [locked, circulating] = await Promise.all([
      viz.gatewayBalanceMilliViz(),
      ton ? ton.circulatingSupplyMilliViz() : Promise.resolve(0n),
    ]);
    const drift = locked - circulating;
    const absDrift = drift < 0n ? -drift : drift;
    const ok = absDrift <= cfg.recon.driftToleranceMilliViz;
    console.log(
      `[recon] locked=${locked} circulating=${circulating} drift=${drift} status=${ok ? "OK" : "DRIFT"}`,
    );
    if (!ok) {
      // Trip the shared, cross-process global pause. All watchers/signers see it.
      // Clearing it is a deliberate T-of-N operator action (unpause), never automatic.
      const reason = `peg drift ${drift} mVIZ (locked=${locked}, circulating=${circulating})`;
      await store.pause(reason);
      console.error(`[recon] CRITICAL: PEG DRIFT DETECTED -> gateway paused: ${reason}`);
    }
    return ok;
  };

  if (once) {
    const ok = await check();
    await store.close();
    process.exit(ok ? 0 : 2);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await check();
    } catch (err) {
      console.error("[recon] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, cfg.recon.intervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
