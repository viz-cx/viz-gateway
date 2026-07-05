import {
  canonicalPegOut,
  CircuitBreaker,
  createStore,
  loadConfig,
  type RemoteChain,
  type SolanaMintProposal,
} from "@gateway/common";
import { SolanaChain } from "./solanaChain";

/**
 * solana-watcher: follows the Solana finalized slot, detects wVIZ returns to the
 * gateway token account (peg-out), and ENQUEUES a durable PEG_OUT action. The
 * separate dispatcher delivers it to the coordinator with retries — the watcher
 * never loses an action on a failed submit.
 * Structurally identical to gram-watcher (shared RemoteChain interface).
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
    null,
    { maxSignatures: cfg.solana.scanMaxSignatures, txDelayMs: cfg.solana.scanTxDelayMs },
  );
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps, store);

  let cursor = 0;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `[solana-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} mint=${cfg.solana.wvizMint}`,
  );

  while (running) {
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
          const first = await store.enqueue({
            id: action.id,
            direction: "PEG_OUT",
            remoteChain: action.remoteChain,
            recipient: action.recipient,
            amountMilliViz: action.amountMilliViz,
            digest: action.digest,
            status: "SEEN",
          });
          if (!first) continue; // already handled
          // Atomic check+record (see checkAndRecord): reserves the 24h window slot in the same
          // transaction as the check so concurrent watchers cannot both slip past the cap.
          const decision = await breaker.checkAndRecord(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[solana-watcher] return ${action.id} held: ${decision.reason}`);
            await store.setStatus(action.id, "HELD", { lastError: decision.reason });
            if (decision.reason === "OVER_24H") {
              await store.pause("Solana peg-out 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          await store.setStatus(action.id, "QUEUED");
          console.log(
            `[solana-watcher] peg-out ${action.id} QUEUED -> release ${action.amountMilliViz} mVIZ to ${action.recipient}`,
          );
        }
        cursor = slot;
      }
    } catch (err) {
      console.error("[solana-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  await store.close();
  console.log("[solana-watcher] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
