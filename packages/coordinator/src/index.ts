import { createServer } from "node:http";
import { actionFromWire, BodyError, buildGatewayAccounts, createStore, loadConfig, readLimitedBody, type CanonicalAction } from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import { Orchestrator } from "./orchestrator";
import { HttpSignerClient, SolanaMintBroadcaster, GramMintBroadcaster, VizReleaseBroadcaster } from "./adapters";

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

  const signers = cfg.coordinator.signerEndpoints.map(
    (ep, i) => new HttpSignerClient(`signer-${i + 1}`, ep, cfg.coordinator.signerApproveTimeoutMs),
  );

  const accounts = buildGatewayAccounts(cfg);
  const vizChain = new VizJsChain(cfg.viz.nodeUrl, accounts);
  const vizBroadcaster = new VizReleaseBroadcaster(vizChain, accounts, store);

  // The single designated TON proposer = first federation operator (see GramMintBroadcaster).
  const tonProposerId = cfg.federation.operators[0]?.id;
  // Keyless on TON: no signer mnemonic. The coordinator only DESCRIBES the mint order;
  // operators approve it on-chain from their own wallets. The designated proposer (the
  // one operator that sends `new_order`) is the first federation operator — the signer
  // list must be ordered so this operator is contacted first (harness + deploy invariant).
  if (cfg.gram.jettonMinterAddress && !tonProposerId) {
    throw new Error("TON minter configured but no federation operators to designate as proposer");
  }
  const tonBroadcaster =
    cfg.gram.jettonMinterAddress && tonProposerId
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
          cfg.fees,
          store,
          tonProposerId,
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
      signers,
      broadcaster,
      (id, feeMilliViz) => store.setFee(id, feeMilliViz),
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
    json(404, { error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(
      `[coordinator] listening on ${host}:${port}; threshold=${cfg.federation.threshold}-of-${cfg.federation.n}; signers=${signers.length}`,
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
