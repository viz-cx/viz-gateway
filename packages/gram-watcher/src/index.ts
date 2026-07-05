import { canonicalPegOut, CircuitBreaker, createStore, loadConfig } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { GramHttpChain } from "./gramChain";

/** Durable scan-cursor name; value is the last-processed logical time (lt). */
const CURSOR = "cursor:gram-watcher";

/**
 * gram-watcher: follows TON masterchain finality, detects wVIZ burns, and
 * ENQUEUES a durable PEG_OUT action. The separate dispatcher delivers it to the
 * coordinator with retries — the watcher never loses an action on a failed submit.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.gram.jettonMinterAddress) {
    throw new Error(
      "GRAM_JETTON_MINTER_ADDRESS is required (set it after deploying the wVIZ Jetton minter).",
    );
  }
  const chain = new GramHttpChain(
    cfg.gram.endpoint,
    cfg.gram.apiKey,
    cfg.gram.jettonMinterAddress,
    cfg.gram.gatewayJettonWallet,
    cfg.gram.multisigAddress,
    cfg.gram.finalityConfirmations,
    cfg.gram.scanMaxTransactions,
    cfg.gram.maxScanPages,
  );
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps, store);

  // Last-processed logical time, resumed from the durable store so downtime never
  // silently skips burns (VG-06). Cold start (0) begins at the wallet tip's lt.
  let cursor = await store.getCursor(CURSOR);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `[gram-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} minter=${cfg.gram.jettonMinterAddress || "unset"}`,
  );

  while (running) {
    try {
      if (await store.isPaused()) {
        console.warn(`[gram-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (cursor === 0) {
        // Cold start: begin at the wallet tip's lt so we don't replay all history
        // (backfill before first-ever run is a separate, deliberate operation).
        cursor = await chain.newestLt();
        await store.setCursor(CURSOR, cursor);
        console.log(`[gram-watcher] starting at lt ${cursor}`);
      } else {
        const { burns, newestFinalLt, drained } = await chain.finalizedBurnsPaginated(cursor);
        for (const burn of burns) {
          const action = canonicalPegOut(burn);
          const first = await store.enqueue({
            id: action.id,
            direction: "PEG_OUT",
            recipient: action.recipient,
            amountMilliViz: action.amountMilliViz,
            digest: action.digest,
            status: "SEEN",
          });
          if (!first) continue;
          const decision = await breaker.check(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[gram-watcher] burn ${action.id} held: ${decision.reason}`);
            await store.setStatus(action.id, "HELD", { lastError: decision.reason });
            if (decision.reason === "OVER_24H") {
              await store.pause("TON peg-out 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          await breaker.record(action.amountMilliViz);
          await store.setStatus(action.id, "QUEUED");
          console.log(
            `[gram-watcher] peg-out ${action.id} QUEUED -> release ${action.amountMilliViz} mVIZ to ${action.recipient}`,
          );
        }
        if (drained) {
          // Only advance the cursor once the tick fully drained back to it; the
          // not-yet-final tail (lt > newestFinalLt) is re-scanned next tick.
          cursor = newestFinalLt;
          await store.setCursor(CURSOR, cursor);
        } else {
          // A burst larger than maxScanPages*scanMaxTransactions: older burns lie
          // beyond what we could scan. Fail closed — do NOT advance past them; pause
          // + alert so an operator raises the scan window rather than silently drop.
          const reason = `TON peg-out scan truncated at lt ${cursor}: burst exceeds scan window (maxScanPages=${cfg.gram.maxScanPages})`;
          console.error(`[gram-watcher] ${reason}`);
          notifyStaff("withdraws", reason, { cursorLt: cursor, newestFinalLt });
          await store.pause(reason); // shared, cross-process
        }
      }
    } catch (err) {
      console.error("[gram-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  await store.close();
  console.log("[gram-watcher] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
