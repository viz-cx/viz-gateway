import { canonicalPegOut, CircuitBreaker, createStore, loadConfig, type TonChain } from "@gateway/common";
import { TonHttpChain } from "./tonChain";

/**
 * ton-watcher: follows TON masterchain finality, detects wVIZ burns, and
 * ENQUEUES a durable PEG_OUT action. The separate dispatcher delivers it to the
 * coordinator with retries — the watcher never loses an action on a failed submit.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ton.jettonMinterAddress) {
    throw new Error(
      "TON_JETTON_MINTER_ADDRESS is required (set it after deploying the wVIZ Jetton minter).",
    );
  }
  const chain: TonChain = new TonHttpChain(
    cfg.ton.endpoint,
    cfg.ton.apiKey,
    cfg.ton.jettonMinterAddress,
    cfg.ton.gatewayJettonWallet,
    cfg.ton.finalityConfirmations,
    cfg.ton.scanMaxTransactions,
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
    `[ton-watcher] operator=${cfg.operatorId} federation=${cfg.federation.threshold}-of-${cfg.federation.n} minter=${cfg.ton.jettonMinterAddress || "unset"}`,
  );

  while (running) {
    try {
      if (await store.isPaused()) {
        console.warn(`[ton-watcher] gateway paused (${await store.pauseReason()}); skipping scan`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const mc = await chain.finalizedHeight();
      const finalHead = mc - cfg.ton.finalityConfirmations;
      if (cursor === 0) {
        cursor = finalHead;
        console.log(`[ton-watcher] starting at masterchain head ${cursor} (mc ${mc})`);
      } else if (finalHead > cursor) {
        const burns = await chain.finalizedBurnsSince(cursor, finalHead);
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
            console.warn(`[ton-watcher] burn ${action.id} held: ${decision.reason}`);
            await store.setStatus(action.id, "HELD", { lastError: decision.reason });
            if (decision.reason === "OVER_24H") {
              await store.pause("TON peg-out 24h cap exceeded"); // shared, cross-process
            }
            continue;
          }
          await breaker.record(action.amountMilliViz);
          await store.setStatus(action.id, "QUEUED");
          console.log(
            `[ton-watcher] peg-out ${action.id} QUEUED -> release ${action.amountMilliViz} mVIZ to ${action.recipient}`,
          );
        }
        cursor = finalHead;
      }
    } catch (err) {
      console.error("[ton-watcher] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  await store.close();
  console.log("[ton-watcher] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
