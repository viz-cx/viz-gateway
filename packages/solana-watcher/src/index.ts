import {
  canonicalPegOut,
  CircuitBreaker,
  createStore,
  loadConfig,
} from "@gateway/common";
import { notifyStaff } from "@gateway/log";
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
  const chain = new SolanaChain(
    cfg.solana.rpcUrl,
    cfg.solana.wvizMint,
    cfg.solana.gatewayTokenAccount,
    cfg.solana.finalitySlots,
    null,
    {
      maxSignatures: cfg.solana.scanMaxSignatures,
      maxScanPages: cfg.solana.maxScanPages,
      txDelayMs: cfg.solana.scanTxDelayMs,
    },
  );
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps, store);

  // Durable scan-cursor. On restart, resume from the last processed slot instead of jumping to
  // the current finalized head — an in-memory cursor silently dropped every burn that landed
  // during downtime (peg-out never released = lost funds). viz/gram-watcher persist theirs for
  // exactly this reason.
  const CURSOR = "cursor:solana-watcher";
  let cursor = await store.getCursor(CURSOR);
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
        await store.setCursor(CURSOR, cursor);
        console.log(`[solana-watcher] starting at finalized slot ${cursor}`);
      } else if (slot > cursor) {
        const { burns, newestFinalSlot, drained } = await chain.finalizedBurnsPaginated(cursor);
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
        if (drained) {
          // Only advance the cursor once the tick fully drained back to it; the
          // not-yet-final tail (slot > safeSlot) is re-scanned next tick.
          cursor = newestFinalSlot;
          await store.setCursor(CURSOR, cursor);
        } else {
          // A burst larger than maxScanPages*scanMaxSignatures: older burns lie beyond what
          // we could scan this tick. Fail closed — do NOT advance past them; pause + alert so
          // operators raise the window / catch up rather than silently skip peg-outs (funds
          // locked with no wVIZ burned would otherwise never be released = lost funds).
          const reason = `Solana peg-out scan truncated at slot ${cursor}: burst exceeds scan window (maxScanPages=${cfg.solana.maxScanPages})`;
          console.error(`[solana-watcher] ${reason}`);
          notifyStaff("withdraws", reason, { cursorSlot: cursor, newestFinalSlot });
          await store.pause(reason); // shared, cross-process
        }
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
