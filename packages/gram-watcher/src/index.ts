import { buildGatewayAccounts, canonicalPegOut, CircuitBreaker, createStore, loadConfig, recoverStaleSeen } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { coldStartAnchorLt, GramHttpChain } from "./gramChain";
import { classifyPegOutDestination } from "./returnClassify";

/** Durable scan-cursor name; value is the last-processed logical time (lt). */
const CURSOR = "cursor:gram-watcher";

/** A peg-out stuck in SEEN longer than this (a crash between enqueue and QUEUED) is recovered. */
const STALE_SEEN_MS = 5 * 60 * 1000;

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
    cfg.gram.rpcTimeoutMs,
  );
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps, store);
  const vizChain = new VizJsChain(cfg.viz.nodeUrl, buildGatewayAccounts(cfg));

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
      // Recover GRAM peg-outs stranded in SEEN by a crash between enqueue and QUEUED (M6). The
      // TON burn was already final before the enqueue, so re-running the cap decision and
      // advancing matches the live path. Scoped to GRAM so it never touches Solana peg-out rows
      // (which the pegoutScanner owns with its burn-checkpoint recovery).
      const seen = await recoverStaleSeen(store, breaker, {
        now: Date.now(),
        staleMs: STALE_SEEN_MS,
        match: (r) => r.direction === "PEG_OUT" && r.remoteChain === "GRAM",
        capPauseReason: "TON peg-out 24h cap exceeded",
      });
      for (const r of seen.requeued)
        notifyStaff("withdraws", `recovered peg-out ${r.id} stranded in SEEN -> QUEUED (missed release)`, { id: r.id, amountMilliViz: String(r.amountMilliViz) });
      for (const r of seen.held)
        notifyStaff("withdraws", `peg-out ${r.id} recovered from SEEN but HELD (${r.lastError ?? "cap"})`, { id: r.id });

      if (cursor === 0) {
        // Cold start: anchor JUST BELOW the wallet tip so we don't replay all history
        // (backfill before first-ever run is a separate, deliberate operation) WITHOUT
        // skipping the tip itself. The scan collects lt > cursor, so anchoring AT the
        // tip's lt would drop the tip tx — and if that tip is the wallet's first-ever tx
        // and an unprocessed peg-out deposit, it would be lost forever. coldStartAnchorLt
        // returns tip-1 (never a real lt), keeping the tip in range; empty wallet -> 0.
        const tip = await chain.newestLt();
        cursor = coldStartAnchorLt(tip);
        await store.setCursor(CURSOR, cursor);
        console.log(`[gram-watcher] cold start at lt ${cursor} (wallet tip ${tip})`);
      } else {
        const { burns, newestFinalLt, drained } = await chain.finalizedBurnsPaginated(cursor);
        for (const burn of burns) {
          const action = canonicalPegOut(burn);
          const first = await store.enqueue({
            id: action.id,
            direction: "PEG_OUT",
            remoteChain: action.remoteChain,
            recipient: action.recipient,
            sender: burn.from, // original TON sender — enables auto-return on an unusable destination
            amountMilliViz: action.amountMilliViz,
            digest: action.digest,
            status: "SEEN",
          });
          if (!first) continue;

          // Auto-return: an unusable VIZ destination (empty/malformed/non-existent) can never
          // receive a release, so park it for the dispatcher's GRAM_RETURN path instead of QUEUED.
          // Routing hint only — each signer re-checks independently before the wVIZ moves.
          const reason = await classifyPegOutDestination(action.recipient, (n) => vizChain.accountExists(n));
          if (reason) {
            await store.setStatus(action.id, "HELD", { lastError: reason });
            console.log(`[gram-watcher] peg-out ${action.id} HELD(${reason}) -> auto-return wVIZ to ${burn.from}`);
            continue;
          }

          // Atomic check+record (see checkAndRecord): reserves the 24h window slot in the same
          // transaction as the check so concurrent watchers cannot both slip past the cap.
          const decision = await breaker.checkAndRecord(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[gram-watcher] burn ${action.id} held: ${decision.reason}`);
            await store.setStatus(action.id, "HELD", { lastError: decision.reason });
            if (decision.reason === "OVER_24H") {
              await store.pause("TON peg-out 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
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
