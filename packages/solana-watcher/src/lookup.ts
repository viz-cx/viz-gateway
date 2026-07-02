import { createServer } from "node:http";
import { createStore, loadConfig } from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { depositAddress, depositAta } from "./depositAddress";

/**
 * Deposit-address lookup service (peg-out Variant A). Stateless derivation:
 * GET /address?viz_account=alice  ->  { address, ata, mint, network: "solana" }.
 * The address is derived deterministically and registered so the scanner watches
 * it. Open/unauthenticated (release is bound to the derivation, so a third party
 * can only gift, never redirect). The response WARNS to send only wVIZ on Solana.
 *
 * The format check is a cheap pre-filter; before issuing (and registering) an
 * address we confirm `viz_account` actually exists on VIZ via a `get_accounts`
 * read, so wVIZ can't be sent to a deposit address for a typo'd/non-existent
 * account (peg-out never refunds → those funds would be stuck). VIZ node
 * unreachable ⇒ fail closed (500), never issue unverified.
 */
const VIZ_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,31}$/; // VIZ/Graphene account-name charset

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
    const vizAccount = (url.searchParams.get("viz_account") ?? "").trim().toLowerCase();
    if (!VIZ_ACCOUNT_RE.test(vizAccount)) {
      json(400, { error: "invalid viz_account" });
      return;
    }
    void (async () => {
      try {
        if (!(await viz.accountExists(vizAccount))) {
          json(404, { error: "viz_account does not exist on VIZ" });
          return;
        }
        const address = depositAddress(cfg.solana.depositMasterSeed, vizAccount);
        const ata = depositAta(cfg.solana.depositMasterSeed, vizAccount, cfg.solana.wvizMint);
        await store.registerDepositAddress({ vizAccount, solAddress: address, wvizAta: ata });
        json(200, {
          viz_account: vizAccount,
          address,
          ata,
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
