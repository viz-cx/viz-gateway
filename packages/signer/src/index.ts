import { createServer } from "node:http";
import {
  actionFromWire,
  createStore,
  loadConfig,
  type SolanaMintProposal,
  type TonMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";
import { KeyedSigner } from "./keyedSigner";
import { routeApproval } from "./routeApproval";

interface ApproveRequest {
  action: Record<string, unknown>;
  proposal: VizReleaseProposal | TonMintProposal | SolanaMintProposal;
}

/**
 * signer service: exposes a minimal local HTTP endpoint the watchers/coordinator
 * call to request this operator's approval for a canonical action. It performs
 * independent validation and then signs. Bind to the operator's private network
 * only; this endpoint must never be publicly reachable.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const signer = new KeyedSigner(
    cfg.operatorId,
    cfg.viz.signingWif,
    cfg.ton.signerMnemonic,
    cfg.fees,
    cfg.solana.signerSecret,
  );
  const store = createStore(cfg.storeUrl);
  const [host, portStr] = (process.env.SIGNER_LISTEN ?? "127.0.0.1:8090").split(":");
  const port = Number.parseInt(portStr ?? "8090", 10);

  const server = createServer((reqStream, res) => {
    if (reqStream.method !== "POST" || reqStream.url !== "/approve") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    reqStream.on("data", (c) => (body += c));
    reqStream.on("end", () => {
      void (async () => {
        try {
          // Refuse to sign anything while the gateway is paused (shared flag).
          if (await store.isPaused()) {
            res.writeHead(423, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "paused", reason: await store.pauseReason() }));
            return;
          }
          const req = JSON.parse(body) as ApproveRequest;
          const action = actionFromWire(req.action);
          const approval = await routeApproval(signer, action, req.proposal);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(approval));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      })();
    });
  });

  server.listen(port, host, () => {
    console.log(
      `[signer] operator=${cfg.operatorId} listening on ${host}:${port} (federation ${cfg.federation.threshold}-of-${cfg.federation.n})`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
