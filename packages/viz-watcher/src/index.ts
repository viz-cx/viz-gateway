import {
  actionToWire,
  canonicalPegIn,
  CircuitBreaker,
  createStore,
  loadConfig,
  type CanonicalAction,
  type VizChain,
} from "@gateway/common";
import { VizJsChain } from "./vizChain";

async function submitToCoordinator(url: string, action: CanonicalAction): Promise<void> {
  const res = await fetch(`${url.replace(/\/$/, "")}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: actionToWire(action) }),
  });
  if (!res.ok) throw new Error(`coordinator -> HTTP ${res.status}`);
}

/**
 * viz-watcher: follows the VIZ irreversible head, detects deposits to the
 * gateway account, derives the canonical peg-in action, applies idempotency +
 * caps, and forwards an approval request to the coordinator/signer.
 *
 * Only acts on irreversible blocks (no reorg exposure).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain: VizChain = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps);

  // Last processed block. In production, persist this and backfill from the last
  // processed block on restart. Cold start (0) begins at the current safe head;
  // historical backfill is a separate, deliberate operation.
  let cursor = 0;

  console.log(
    `[viz-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} gateway=${cfg.viz.gatewayAccount}`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (await store.isPaused()) {
        console.warn(`[viz-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const lib = await chain.lastIrreversibleBlock();
      const safeHead = lib - cfg.viz.extraConfirmations;
      if (cursor === 0) {
        // Cold start: begin at the current safe head; don't scan from genesis.
        cursor = safeHead;
        console.log(`[viz-watcher] starting at irreversible head ${cursor} (LIB ${lib})`);
      } else if (safeHead > cursor) {
        const deposits = await chain.irreversibleDepositsSince(cursor, safeHead);
        for (const dep of deposits) {
          const action = canonicalPegIn(dep);
          const first = await store.claim(action.id);
          if (!first) continue; // already handled
          const decision = breaker.check(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[viz-watcher] deposit ${action.id} held: ${decision.reason}`);
            if (decision.reason === "OVER_24H") {
              breaker.pause("24h cap exceeded");
              await store.pause("VIZ peg-in 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          breaker.record(action.amountMilliViz);
          console.log(
            `[viz-watcher] peg-in ${action.id} -> mint ${action.amountMilliViz} mVIZ to ${action.recipient}`,
          );
          try {
            await submitToCoordinator(cfg.coordinator.url, action);
          } catch (err) {
            // Production: persist to an outbox and retry. The idempotency claim
            // means this action won't be re-detected, so a failed submit needs
            // operator follow-up until the outbox exists.
            console.error(`[viz-watcher] submit ${action.id} failed: ${String(err)}`);
          }
        }
        cursor = safeHead;
      }
    } catch (err) {
      console.error("[viz-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 3000)); // VIZ block interval
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
