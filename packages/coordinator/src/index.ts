import { createServer } from "node:http";
import { resolve } from "node:path";
import { actionFromWire, BodyError, buildGatewayAccounts, createStore, loadConfig, readLimitedBody, pegInFeePolicyFor, median, deriveGramFeePolicy, type CanonicalAction, type PegInFeePolicy } from "@gateway/common";
import { corsHeadersFor, serializeFees, loadAllowedOrigins, serveStatic } from "./http";
import { notifyStaff } from "@gateway/log";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import { Orchestrator } from "./orchestrator";
import { HttpSignerClient, SolanaMintBroadcaster, GramMintBroadcaster, VizReleaseBroadcaster } from "./adapters";
import { SignerRegistry } from "./registry";

/**
 * coordinator: UNTRUSTED. On POST /submit { action } it builds the one shared
 * proposal, asks each signer to validate+sign it, and broadcasts once the
 * threshold is met. Works at 1-of-1 (solo) and unchanged at 7-of-11.
 *
 * KEY CUSTODY — precise statement (do not simplify to "keyless"):
 *   - VIZ:    keyless. Release authority is the operators' secp256k1 M-of-N; the
 *             coordinator only merges partials and broadcasts.
 *   - TON:    keyless. Operators approve the mint order on-chain from their OWN
 *             wallets; the coordinator holds no TON mnemonic.
 *   - Solana: holds the SUBMITTER key (SOLANA_SUBMITTER_SECRET) = fee payer +
 *             durable-nonce authority + ATA funder. This is NOT mint authority:
 *             the mint authority is the on-chain SPL M-of-N multisig, and each
 *             signer pins mint/multisig/nonceAccount/feePayer and re-derives NET.
 *
 * It cannot cause theft on ANY chain: the mint/release authority is always the
 * on-chain M-of-N, and each signer re-validates the proposal against the action it
 * independently derived. The Solana submitter key's worst case is a LIVENESS attack
 * (grind the durable nonce / drain the submitter's SOL) — never fund theft.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = createStore(cfg.storeUrl);

  const registry = new SignerRegistry(
    cfg.federation.operators,
    cfg.registration.leaseMs,
    cfg.registration.nonceTtlMs,
  );
  // Built fresh per action from the LIVE registry so a just-registered / just-expired
  // operator is reflected immediately, and always in federation operator order. The
  // orchestrator contacts these signers sequentially; for a TON mint, whichever live
  // operator is asked first while the order is still absent opens it (no single
  // designated proposer — the role fails over across live operators; see GramApprover).
  const currentSigners = (): HttpSignerClient[] =>
    registry.live().map((r) => new HttpSignerClient(r.operatorId, r.url, cfg.coordinator.signerApproveTimeoutMs));

  const accounts = buildGatewayAccounts(cfg);
  const vizChain = new VizJsChain(cfg.viz.nodeUrl, accounts);
  const vizBroadcaster = new VizReleaseBroadcaster(vizChain, accounts, store);

  // Dynamic GRAM fee floor: median of live per-signer vizPerTon quotes, falling back to
  // the last-good persisted quote, then to the static manifest floor (fail-toward-protection).
  const LAST_GOOD_KEY = "fee:gram:lastGoodVizPerTon";
  const QUOTE_QUORUM = 2; // min fresh quotes to trust the median; else fall back
  const gramFeePolicy = async (): Promise<PegInFeePolicy> => {
    const quotes = registry.liveQuotes();
    if (quotes.length >= QUOTE_QUORUM) {
      const v = median(quotes);
      await store.setState(LAST_GOOD_KEY, String(v));
      return deriveGramFeePolicy(cfg.fees, v);
    }
    const lastGood = await store.getState(LAST_GOOD_KEY);
    if (lastGood) {
      notifyStaff("fees", `GRAM fee: only ${quotes.length} fresh quote(s) < quorum ${QUOTE_QUORUM}; using last-good vizPerTon=${lastGood}`, {});
      return deriveGramFeePolicy(cfg.fees, Number(lastGood));
    }
    // No quotes and no history: fall back to the static manifest floor (never an unprotected zero fee).
    notifyStaff("fees", `GRAM fee: no quotes and no last-good; using static manifest floor`, {});
    return pegInFeePolicyFor(cfg.fees, "GRAM");
  };

  // Keyless on TON: no signer mnemonic. The coordinator only DESCRIBES the mint order;
  // operators open/approve it on-chain from their own wallets. There is no designated
  // proposer — the first live operator contacted opens the order and the role fails over
  // to the next operator if that one is offline/unfunded, so the mint no longer deadlocks
  // when any single operator is down.
  const tonBroadcaster = cfg.gram.jettonMinterAddress
    ? new GramMintBroadcaster(
        new GramHttpChain(
          cfg.gram.endpoint,
          cfg.gram.apiKey,
          cfg.gram.jettonMinterAddress,
          cfg.gram.gatewayJettonWallet,
          cfg.gram.multisigAddress,
          cfg.gram.finalityConfirmations,
          cfg.gram.scanMaxTransactions,
          cfg.gram.maxScanPages,
          cfg.gram.rpcTimeoutMs,
        ),
        gramFeePolicy,
        store,
      )
    : null;
  const solanaBroadcaster =
    cfg.solana.wvizMint && cfg.solana.multisig && cfg.solana.submitterSecret
      ? new SolanaMintBroadcaster(
          new SolanaChain(
            cfg.solana.rpcUrl,
            cfg.solana.wvizMint,
            cfg.solana.gatewayTokenAccount,
            cfg.solana.finalitySlots,
            {
              multisig: cfg.solana.multisig,
              nonceAccount: cfg.solana.nonceAccount,
              submitterSecret: cfg.solana.submitterSecret,
            },
          ),
          cfg.solana.signers,
          cfg.fees,
          store,
        )
      : null;

  const pegInBroadcaster = (action: CanonicalAction) => {
    if (action.remoteChain === "SOLANA") {
      if (!solanaBroadcaster) throw new Error(`Solana PEG_IN ${action.id} but Solana mint not configured`);
      return solanaBroadcaster;
    }
    if (action.remoteChain === "GRAM") {
      if (!tonBroadcaster) throw new Error(`GRAM PEG_IN ${action.id} but GRAM minter not configured`);
      return tonBroadcaster;
    }
    throw new Error(`PEG_IN ${action.id} has unknown/absent remoteChain`);
  };

  const orchestrate = (action: CanonicalAction) => {
    const broadcaster = action.direction === "PEG_OUT" ? vizBroadcaster : pegInBroadcaster(action);
    return new Orchestrator(
      cfg.federation.threshold,
      cfg.federation.operators.map((o) => o.id),
      currentSigners(),
      broadcaster,
      (id, feeMilliViz) => store.setFee(id, feeMilliViz),
    ).process(action);
  };

  const [host, portStr] = cfg.coordinator.listen.split(":");
  const port = Number.parseInt(portStr ?? "8100", 10);

  const allowedOrigins = loadAllowedOrigins(
    process.env.ALLOWED_ORIGINS_FILE ?? resolve(process.cwd(), "config/allowed-origins.json"),
  );
  const siteDir = process.env.SITE_DIR ?? resolve(process.cwd(), "site");
  console.log(`[coordinator] CORS allowlist: ${allowedOrigins.length ? allowedOrigins.join(", ") : "(empty — cross-origin blocked)"}`);
  console.log(`[coordinator] serving static site from ${siteDir}`);

  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/health") {
      const { registered, expected } = registry.count();
      const { live, missing } = registry.roster();
      const cors = corsHeadersFor(req.headers.origin, allowedOrigins);
      void store.isPaused().then((paused) => {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, paused, registered, expected, operators: live, missing }));
      });
      return;
    }
    if (req.method === "OPTIONS" && (req.url === "/health" || req.url === "/fees")) {
      const cors = corsHeadersFor(req.headers.origin, allowedOrigins);
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET" });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/fees") {
      const cors = corsHeadersFor(req.headers.origin, allowedOrigins);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60", ...cors });
      res.end(JSON.stringify(serializeFees(cfg.fees)));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/register/challenge")) {
      try {
        const operator = new URL(req.url, "http://x").searchParams.get("operator") ?? "";
        json(200, registry.issueChallenge(operator));
      } catch (err) {
        json(400, { error: String(err) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/register") {
      void (async () => {
        let body: string;
        try {
          body = await readLimitedBody(req);
        } catch (err) {
          json(err instanceof BodyError ? err.statusCode : 400, { error: String(err) });
          return;
        }
        try {
          const { operator, url, nonce, sig, vizPerTon } = JSON.parse(body) as {
            operator: string; url: string; nonce: string; sig: string; vizPerTon?: number;
          };
          const reg = registry.register(operator, url, nonce, sig, vizPerTon);
          console.log(`[coordinator] registered ${operator} -> ${url} (expires ${new Date(reg.expiresAt).toISOString()})`);
          json(200, { ok: true, expiresAt: reg.expiresAt });
        } catch (err) {
          json(400, { error: String(err) });
        }
      })();
      return;
    }
    if (req.method === "POST" && req.url === "/submit") {
      void (async () => {
        let body: string;
        try {
          body = await readLimitedBody(req); // bounded size + timeout (BM4)
        } catch (err) {
          json(err instanceof BodyError ? err.statusCode : 400, { error: String(err) });
          return;
        }
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
          console.error("[coordinator] /submit failed:", err);
          json(500, { error: String(err) });
        }
      })();
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      void serveStatic(req, res, siteDir);
      return;
    }
    json(404, { error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(
      `[coordinator] listening on ${host}:${port}; threshold=${cfg.federation.threshold}-of-${cfg.federation.n}; awaiting ${cfg.federation.n} signer registration(s)`,
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
