import {
  canonicalPegOut,
  CircuitBreaker,
  createStore,
  loadConfig,
  type TonChain,
} from "@gateway/common";
import { TonChainStub } from "./tonChainStub";
import { TonHttpChain } from "./tonChain";

/**
 * ton-watcher: follows TON masterchain finality, detects wVIZ burns, derives
 * the canonical peg-out action, applies idempotency + caps, and forwards an
 * approval request for the VIZ release.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  // Use the live adapter once the Jetton minter is configured; otherwise the
  // stub keeps the service bootable before the TON contracts are deployed.
  const chain: TonChain = cfg.ton.jettonMinterAddress
    ? new TonHttpChain(
        cfg.ton.endpoint,
        cfg.ton.apiKey,
        cfg.ton.jettonMinterAddress,
        cfg.ton.gatewayJettonWallet,
        cfg.ton.finalityConfirmations,
      )
    : new TonChainStub(cfg.ton.endpoint, cfg.ton.jettonMinterAddress);
  const store = createStore(cfg.storeUrl);
  const breaker = new CircuitBreaker(cfg.caps);

  // In production, persist this cursor. Cold start (0) begins at the current
  // masterchain head; historical backfill is a separate, deliberate operation.
  let cursor = 0;

  console.log(
    `[ton-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} minter=${cfg.ton.jettonMinterAddress || "unset"}`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (await store.isPaused()) {
        console.warn(`[ton-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const mc = await chain.masterchainSeqno();
      const finalHead = mc - cfg.ton.finalityConfirmations;
      if (cursor === 0) {
        cursor = finalHead;
        console.log(`[ton-watcher] starting at masterchain head ${cursor} (mc ${mc})`);
      } else if (finalHead > cursor) {
        const burns = await chain.finalBurnsSince(cursor, finalHead);
        for (const burn of burns) {
          const action = canonicalPegOut(burn);
          const first = await store.claim(action.id);
          if (!first) continue;
          const decision = breaker.check(action.amountMilliViz);
          if (!decision.ok) {
            console.warn(`[ton-watcher] burn ${action.id} held: ${decision.reason}`);
            if (decision.reason === "OVER_24H") {
              breaker.pause("24h cap exceeded");
              await store.pause("TON peg-out 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          breaker.record(action.amountMilliViz);
          console.log(
            `[ton-watcher] peg-out ${action.id} -> release ${action.amountMilliViz} mVIZ to ${action.recipient}; digest=${action.digest}`,
          );
          // TODO: POST { action } to coordinator; signer co-signs the VIZ transfer.
        }
        cursor = finalHead;
      }
    } catch (err) {
      console.error("[ton-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
