import {
  actionToWire,
  canonicalPegOut,
  CircuitBreaker,
  createStore,
  loadConfig,
  type CanonicalAction,
  type RemoteChain,
  type SolanaMintProposal,
} from "@gateway/common";
import { SolanaChain } from "./solanaChain";

async function submitToCoordinator(url: string, action: CanonicalAction): Promise<void> {
  const res = await fetch(`${url.replace(/\/$/, "")}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: actionToWire(action) }),
  });
  if (!res.ok) throw new Error(`coordinator -> HTTP ${res.status}`);
}

/**
 * solana-watcher: follows the Solana finalized slot, detects wVIZ returns to the
 * gateway token account (peg-out), and submits the VIZ release to the coordinator.
 * Structurally identical to ton-watcher — both speak the shared RemoteChain
 * interface — which is the point of the multi-network abstraction.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.solana.wvizMint) {
    throw new Error("SOLANA_WVIZ_MINT is required (set it after deploying the wVIZ Token-2022 mint).");
  }
  const chain: RemoteChain<SolanaMintProposal> = new SolanaChain(
    cfg.solana.rpcUrl,
    cfg.solana.wvizMint,
    cfg.solana.gatewayTokenAccount,
    cfg.solana.finalitySlots,
  );
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps);

  let cursor = 0;
  console.log(
    `[solana-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} mint=${cfg.solana.wvizMint}`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (await store.isPaused()) {
        console.warn(`[solana-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      const slot = await chain.finalizedHeight();
      if (cursor === 0) {
        cursor = slot;
        console.log(`[solana-watcher] starting at finalized slot ${cursor}`);
      } else if (slot > cursor) {
        const burns = await chain.finalizedBurnsSince(cursor, slot);
        for (const burn of burns) {
          const action = canonicalPegOut(burn);
          const first = await store.claim(action.id);
          if (!first) continue;
          const decision = breaker.check(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[solana-watcher] return ${action.id} held: ${decision.reason}`);
            if (decision.reason === "OVER_24H") {
              breaker.pause("24h cap exceeded");
              await store.pause("Solana peg-out 24h cap exceeded");
            }
            continue;
          }
          breaker.record(action.amountMilliViz);
          console.log(
            `[solana-watcher] peg-out ${action.id} -> release ${action.amountMilliViz} mVIZ to ${action.recipient}`,
          );
          try {
            await submitToCoordinator(cfg.coordinator.url, action);
          } catch (err) {
            console.error(`[solana-watcher] submit ${action.id} failed: ${String(err)}`);
          }
        }
        cursor = slot;
      }
    } catch (err) {
      console.error("[solana-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
