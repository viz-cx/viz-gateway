import {
  buildGatewayAccounts,
  canonicalPegIn,
  CircuitBreaker,
  createStore,
  loadConfig,
  recoverStaleSeen,
  type VizChain,
} from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { nextScanWindow, VizJsChain } from "./vizChain";

/** Durable scan-cursor name (persisted in the shared store; survives restart). */
const CURSOR = "cursor:viz-watcher";

/** A peg-in stuck in SEEN longer than this (a crash between enqueue and QUEUED) is recovered. */
const STALE_SEEN_MS = 5 * 60 * 1000;

/**
 * viz-watcher: follows the VIZ irreversible head, detects deposits to the gateway
 * account, derives the canonical peg-in action (amount = GROSS; the fee/net are
 * finalized at proposal-build in the coordinator), applies idempotency + caps,
 * and ENQUEUES a durable PEG_IN action. The separate dispatcher delivers it to
 * the coordinator with retries — no action is lost on a failed submit.
 *
 * Only acts on irreversible blocks (no reorg exposure).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const accounts = buildGatewayAccounts(cfg);
  const chain: VizChain = new VizJsChain(cfg.viz.nodeUrl, accounts);
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps, store);

  // Last processed block, resumed from the durable store so downtime doesn't skip
  // deposits (VG-03). Cold start (0) begins at the current safe head and persists
  // it once; historical backfill before first-ever run is a separate operation.
  let cursor = await store.getCursor(CURSOR);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `[viz-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} gateway=${accounts.all().join(",")}`,
  );

  while (running) {
    // A backlog larger than one scan window means catch up on the next tick
    // immediately (no block sleep), so downtime is drained fast, not one cap/3s.
    let caughtUp = true;
    try {
      if (await store.isPaused()) {
        console.warn(`[viz-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      // Recover peg-ins stranded in SEEN by a crash between enqueue and QUEUED (M6). The VIZ
      // deposit was already irreversible before the enqueue, so re-running the cap decision and
      // advancing is exactly what the live path would have done — just delayed to here.
      const seen = await recoverStaleSeen(store, breaker, {
        now: Date.now(),
        staleMs: STALE_SEEN_MS,
        match: (r) => r.direction === "PEG_IN",
        capPauseReason: "VIZ peg-in 24h cap exceeded",
      });
      for (const r of seen.requeued)
        notifyStaff("deposits", `recovered peg-in ${r.id} stranded in SEEN -> QUEUED (missed mint)`, { id: r.id, amountMilliViz: String(r.amountMilliViz) });
      for (const r of seen.held)
        notifyStaff("deposits", `peg-in ${r.id} recovered from SEEN but HELD (${r.lastError ?? "cap"})`, { id: r.id });

      const lib = await chain.lastIrreversibleBlock();
      const safeHead = lib - cfg.viz.extraConfirmations;
      if (cursor === 0) {
        cursor = safeHead;
        await store.setCursor(CURSOR, cursor); // make the "start here" decision once
        console.log(`[viz-watcher] starting at irreversible head ${cursor} (LIB ${lib})`);
      } else if (safeHead > cursor) {
        // Advance only to what a single irreversibleDepositsSince call can scan; a
        // larger backlog is caught over successive ticks, never skipped (VG-03).
        const { scannedTo, caughtUp: reached } = nextScanWindow(cursor, safeHead);
        const deposits = await chain.irreversibleDepositsSince(cursor, scannedTo);
        for (const dep of deposits) {
          const action = canonicalPegIn(dep);
          // No-memo / invalid-destination deposit: it has NO valid mint target (the signer
          // would refuse to mint it anyway), so it must never enter the mint/caps path. Enqueue
          // it durably as HELD("INVALID_DESTINATION") — the marker the dispatcher's auto-refund
          // branch keys on to return the gross to the sender. Skip caps (a refund returns funds;
          // caps guard minting). Recipient is the "" sentinel; the refund target is `sender`.
          if (!dep.destinationValid) {
            const first = await store.enqueue({
              id: action.id,
              direction: "PEG_IN",
              remoteChain: action.remoteChain,
              recipient: action.recipient, // "" sentinel — never used (never minted)
              sender: dep.from, // VIZ sender — the auto-refund target
              amountMilliViz: action.amountMilliViz, // GROSS (refunded in full, no fee)
              digest: action.digest,
              status: "HELD",
              lastError: "INVALID_DESTINATION",
            });
            if (first)
              notifyStaff("deposits", `peg-in ${action.id} HELD: invalid/empty destination -> auto-refund to ${dep.from}`, {
                id: action.id,
                sender: dep.from,
                amountMilliViz: String(action.amountMilliViz),
              });
            continue;
          }
          const first = await store.enqueue({
            id: action.id,
            direction: "PEG_IN",
            remoteChain: action.remoteChain,
            recipient: action.recipient,
            sender: dep.from, // VIZ sender — refund target if delivery fails
            amountMilliViz: action.amountMilliViz, // GROSS; fee/net finalized at proposal build
            digest: action.digest,
            status: "SEEN",
          });
          if (!first) continue; // already handled
          // Atomic check+record: the 24h window slot is reserved in the same transaction as the
          // check, so concurrent watchers cannot both slip past the cap (see checkAndRecord).
          const decision = await breaker.checkAndRecord(action.amountMilliViz);
          if (!decision.ok) {
            // Caps are on the GROSS deposit. Hold (do not drop) — the deposit is
            // recoverable: an operator can release the cap or refund.
            console.warn(`[viz-watcher] deposit ${action.id} held: ${decision.reason}`);
            await store.setStatus(action.id, "HELD", { lastError: decision.reason });
            if (decision.reason === "OVER_24H") {
              await store.pause("VIZ peg-in 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          await store.setStatus(action.id, "QUEUED");
          console.log(
            `[viz-watcher] peg-in ${action.id} QUEUED -> mint to ${action.recipient} on ${action.remoteChain} (gross ${action.amountMilliViz} mVIZ)`,
          );
        }
        cursor = scannedTo;
        await store.setCursor(CURSOR, cursor);
        caughtUp = reached;
      }
    } catch (err) {
      console.error("[viz-watcher] loop error:", err);
    }
    if (caughtUp) await new Promise((r) => setTimeout(r, 3000)); // VIZ block interval
  }

  await store.close();
  console.log("[viz-watcher] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
