import { createServer } from "node:http";
import { createStore, loadConfig } from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { depositAddress, depositAta } from "./depositAddress";
import { resolveDepositAddress } from "./lookupValidate";

/**
 * Deposit-address lookup service (peg-out Variant A). Stateless derivation:
 * GET /address?viz_account=alice  ->  { address, ata, mint, network: "solana" }.
 * The address is derived deterministically and registered so the scanner watches
 * it. Open/unauthenticated (release is bound to the derivation, so a third party
 * can only gift, never redirect). The response WARNS to send only wVIZ on Solana.
 *
 * The request decision (format pre-filter → on-chain existence gate) is the pure
 * `resolveDepositAddress` in `lookupValidate.ts`. Confirming `viz_account` exists
 * on VIZ before issuing means wVIZ can't be sent to a deposit address for a
 * typo'd/non-existent account (peg-out never refunds → those funds would be
 * stuck); a VIZ node outage propagates as a throw → fail closed (500), never
 * issue unverified.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.solana.depositMasterSeed) throw new Error("SOLANA_DEPOSIT_MASTER_SEED is required for the lookup service");
  if (!cfg.solana.wvizMint) throw new Error("SOLANA_WVIZ_MINT is required");
  const store = createStore(cfg.storeUrl);
  const viz = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
  const [host, portStr] = cfg.solana.lookupListen.split(":");
  const port = Number.parseInt(portStr ?? "8095", 10);

  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/address") {
      json(404, { error: "not found" });
      return;
    }
    void (async () => {
      try {
        const decision = await resolveDepositAddress(url.searchParams.get("viz_account"), {
          accountExists: (name) => viz.accountExists(name),
          depositAddress: (name) => depositAddress(cfg.solana.depositMasterSeed, name),
          depositAta: (name) => depositAta(cfg.solana.depositMasterSeed, name, cfg.solana.wvizMint),
        });
        if (decision.status !== 200) {
          json(decision.status, decision.body);
          return;
        }
        await store.registerDepositAddress({
          vizAccount: decision.vizAccount,
          solAddress: decision.address,
          wvizAta: decision.ata,
        });
        json(200, {
          viz_account: decision.vizAccount,
          address: decision.address,
          ata: decision.ata,
          mint: cfg.solana.wvizMint,
          network: "solana",
          warning: "Send ONLY wVIZ (this mint) on Solana to this address. Other tokens/networks are lost.",
          rate: "1:1, no fee",
        });
      } catch (err) {
        json(500, { error: String(err) });
      }
    })();
  });

  server.listen(port, host, () => console.log(`[lookup] listening on ${host}:${port} (mint ${cfg.solana.wvizMint})`));
  const shutdown = () => server.close(() => void store.close().then(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
