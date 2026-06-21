import { createServer } from "node:http";
import { actionFromWire, createStore, loadConfig, type CanonicalAction } from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";
import { Orchestrator } from "./orchestrator";
import { HttpSignerClient, TonMintBroadcaster, VizReleaseBroadcaster } from "./adapters";

/**
 * coordinator: UNTRUSTED, keyless. On POST /submit { action } it builds the one
 * shared proposal, asks each signer to validate+sign it, and broadcasts once the
 * threshold is met. Works at 1-of-1 (solo) and unchanged at 7-of-11.
 *
 * It cannot cause theft: it holds no keys, and each signer re-validates the
 * proposal against the action. Worst case is a liveness stall.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = createStore(cfg.storeUrl);

  const signers = cfg.coordinator.signerEndpoints.map(
    (ep, i) => new HttpSignerClient(`signer-${i + 1}`, ep),
  );

  const vizChain = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
  const vizBroadcaster = new VizReleaseBroadcaster(vizChain, cfg.viz.gatewayAccount);
  const tonBroadcaster = cfg.ton.jettonMinterAddress
    ? new TonMintBroadcaster(
        new TonHttpChain(
          cfg.ton.endpoint,
          cfg.ton.apiKey,
          cfg.ton.jettonMinterAddress,
          cfg.ton.gatewayJettonWallet,
          cfg.ton.finalityConfirmations,
        ),
      )
    : null;

  const orchestrate = (action: CanonicalAction) => {
    const broadcaster = action.direction === "PEG_OUT" ? vizBroadcaster : tonBroadcaster;
    if (!broadcaster) throw new Error("PEG_IN requested but TON minter not configured");
    return new Orchestrator(
      cfg.federation.threshold,
      cfg.federation.operators.map((o) => o.id),
      signers,
      broadcaster,
    ).process(action);
  };

  const [host, portStr] = cfg.coordinator.listen.split(":");
  const port = Number.parseInt(portStr ?? "8080", 10);

  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/health") {
      void store.isPaused().then((paused) => json(200, { ok: true, paused, signers: signers.length }));
      return;
    }
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            if (await store.isPaused()) {
              json(423, { error: "paused", reason: await store.pauseReason() });
              return;
            }
            const raw = JSON.parse(body) as { action: Record<string, unknown> };
            const action = actionFromWire(raw.action);
            const result = await orchestrate(action);
            console.log(`[coordinator] ${action.id} -> ${JSON.stringify(result)}`);
            json(200, result);
          } catch (err) {
            json(500, { error: String(err) });
          }
        })();
      });
      return;
    }
    json(404, { error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(
      `[coordinator] listening on ${host}:${port}; threshold=${cfg.federation.threshold}-of-${cfg.federation.n}; signers=${signers.length}`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
