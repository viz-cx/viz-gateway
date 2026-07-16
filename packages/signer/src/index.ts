import { createServer } from "node:http";
import {
  actionFromWire,
  BodyError,
  buildGatewayAccounts,
  createStore,
  loadConfig,
  readLimitedBody,
  type SolanaMintProposal,
  type GramMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
import { GramApprover } from "@gateway/gram-watcher/dist/gramApprove";
import { KeyedSigner } from "./keyedSigner";
import { routeApproval } from "./routeApproval";
import { validateAction, type BurnReader, type SourceValidatorDeps } from "./sourceValidator";
import { startRegisterLoop } from "./register";
import { resolveOperatorId } from "./resolveOperatorId";

interface ApproveRequest {
  action: Record<string, unknown>;
  proposal: VizReleaseProposal | GramMintProposal | SolanaMintProposal;
}

/**
 * signer service: exposes a minimal local HTTP endpoint the watchers/coordinator
 * call to request this operator's approval for a canonical action. It performs
 * independent validation and then signs. Bind to the operator's private network
 * only; this endpoint must never be publicly reachable.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  // Self-registration is now the only way the coordinator discovers this signer, and the
  // challenge is signed with the operator's VIZ key — so both are required to boot.
  if (!cfg.signerAdvertiseUrl) {
    throw new Error("SIGNER_ADVERTISE_URL is required: the coordinator discovers this signer via self-registration.");
  }
  try {
    new URL(cfg.signerAdvertiseUrl);
  } catch {
    throw new Error(`SIGNER_ADVERTISE_URL is not a valid URL: ${cfg.signerAdvertiseUrl}`);
  }
  if (!cfg.viz.signingWif) {
    throw new Error("VIZ_SIGNING_WIF is required to self-register (the challenge is signed with the operator's VIZ key).");
  }

  // This box's operator slot is DERIVED from its VIZ key (looked up in federation.json),
  // not hand-set — the key is the identity, so an operator never has to know or type their
  // slot. OPERATOR_ID remains optional + advisory (warns + is overridden if it disagrees).
  const operatorId = resolveOperatorId(cfg.viz.signingWif, cfg.federation.operators, process.env.OPERATOR_ID);

  // Boot-time custody guard. A signer with NEITHER key can approve nothing: it can't
  // propose/approve a TON peg-in mint (needs GRAM_SIGNER_MNEMONIC) nor sign a VIZ peg-out
  // release (needs VIZ_SIGNING_WIF). Booting "healthy" in that state is a footgun — the
  // daemon answers /approve and only fails at signing time, so a mis-sealed keystore looks
  // fine until the first real transfer. Fail closed at start (seal both into FED_KEYSTORE;
  // see docs/runbook-mainnet-bringup.md §3.3).
  if (!cfg.viz.signingWif && !cfg.gram.signerMnemonic) {
    throw new Error(
      "signer has no signing key: set VIZ_SIGNING_WIF and GRAM_SIGNER_MNEMONIC (or a " +
        "FED_KEYSTORE sealing both). A keyless signer can approve nothing.",
    );
  }
  // Exactly one key present = direction-degraded (this operator can serve one leg only).
  // Not fatal in an M-of-N where peers cover the other leg, but surface it loudly.
  if (!cfg.viz.signingWif) {
    console.warn("[signer] WARNING: VIZ_SIGNING_WIF unset — cannot sign VIZ peg-out releases (peg-out degraded).");
  }
  if (!cfg.gram.signerMnemonic) {
    console.warn("[signer] WARNING: GRAM_SIGNER_MNEMONIC unset — cannot approve GRAM peg-in mints (peg-in degraded).");
  }

  const accounts = buildGatewayAccounts(cfg);
  const store = createStore(cfg.storeUrl);

  // F2 INDEPENDENCE LINCHPIN: these readers MUST point at the operator's OWN nodes
  // (VIZ_NODE_URL / SOLANA_RPC_URL), never a coordinator-fed endpoint. They re-derive
  // the source event so a compromised coordinator cannot forge a (action, proposal) pair.
  const vizChain = new VizJsChain(cfg.viz.nodeUrl, accounts, cfg.viz.memoWifs);
  // Read-only Solana reader (no writer): only getBurn is exercised here. Constructing it
  // needs a real mint; if Solana is not configured on this signer, a Solana peg-out can
  // never be validated, so fail closed if one ever arrives.
  const solanaReader: BurnReader = cfg.solana.wvizMint
    ? new SolanaChain(cfg.solana.rpcUrl, cfg.solana.wvizMint, cfg.solana.gatewayTokenAccount, cfg.solana.finalitySlots)
    : {
        async getBurn() {
          throw new Error("Solana not configured on this signer (SOLANA_WVIZ_MINT unset); refusing Solana peg-out");
        },
      };
  // Fail fast: a signer wired for Solana peg-out cannot re-derive deposit addresses
  // without the deposit program ID, so refuse to start rather than reject every peg-out
  // later with a cryptic error.
  if (cfg.solana.wvizMint && !cfg.solana.depositProgramId) {
    throw new Error(
      "SOLANA_DEPOSIT_PROGRAM_ID is required when Solana peg-out is configured (SOLANA_WVIZ_MINT set); " +
        "it is the public burn-only deposit program ID used to re-derive deposit addresses.",
    );
  }
  // Read-only TON reader: getBurn bounded-scans the gateway jetton wallet on the operator's
  // OWN TON node — no mnemonic/multisig needed, so pass "" for the write-path fields. If the
  // gateway jetton wallet is not configured, a TON peg-out can never be validated, so fail
  // closed if one ever arrives (mirrors the Solana stub above).
  const tonReader: BurnReader = cfg.gram.gatewayJettonWallet
    ? new GramHttpChain(
        cfg.gram.endpoint,
        cfg.gram.apiKey,
        cfg.gram.jettonMinterAddress,
        cfg.gram.gatewayJettonWallet,
        "", // multisigAddress (read-only reader; order reads not needed here)
        cfg.gram.finalityConfirmations,
        cfg.gram.scanMaxTransactions,
        cfg.gram.maxScanPages,
        cfg.gram.rpcTimeoutMs,
      )
    : {
        async getBurn() {
          throw new Error(
            "GRAM not configured on this signer (GRAM_GATEWAY_JETTON_WALLET unset); refusing GRAM peg-out",
          );
        },
      };
  const validatorDeps: SourceValidatorDeps = {
    vizChain,
    solanaChain: solanaReader,
    tonChain: tonReader,
    store,
    depositProgramId: cfg.solana.depositProgramId,
    // FEE_SWEEP/REFUND re-derivation: the operator's OWN fee config + fees.gate account,
    // never coordinator-fed, so a swept fee can only ever land at this operator's fees.gate.
    fees: cfg.fees,
    feesGateAccount: cfg.feesGateAccount,
    accounts,
  };

  // Pin the Solana accounts to this operator's own config so a compromised coordinator
  // can't redirect a mint (only meaningful once Solana is wired: SOLANA_WVIZ_MINT set).
  const solanaPins = cfg.solana.wvizMint
    ? {
        mint: cfg.solana.wvizMint,
        multisig: cfg.solana.multisig,
        nonceAccount: cfg.solana.nonceAccount,
        // Pinned only when SOLANA_SUBMITTER_PUBKEY is configured (empty => undefined => not pinned).
        feePayer: cfg.solana.submitterPubkey || undefined,
      }
    : null;

  // TON on-chain approver (Phase B): performs this operator's propose/approve from its
  // OWN wallet + node. Wired only when TON is fully configured on this operator; a TON
  // PEG_IN without it is refused (KeyedSigner throws) rather than silently unauthorized.
  const gramApprover =
    cfg.gram.jettonMinterAddress && cfg.gram.multisigAddress && cfg.gram.signerMnemonic
      ? new GramApprover(
          cfg.gram.endpoint,
          cfg.gram.apiKey,
          cfg.gram.jettonMinterAddress,
          cfg.gram.multisigAddress,
          cfg.gram.signerMnemonic,
          {
            maxWaitMs: cfg.gram.approveMaxWaitMs,
            pollIntervalMs: cfg.gram.approvePollIntervalMs,
            orderValueNano: BigInt(cfg.gram.orderValueNano),
          },
        )
      : null;

  const signer = new KeyedSigner(
    operatorId,
    cfg.viz.signingWif,
    cfg.gram.signerMnemonic,
    cfg.fees,
    cfg.solana.signerSecret,
    (action) => validateAction(action, validatorDeps),
    solanaPins,
    gramApprover,
    accounts,
  );
  // Default 8101 (not 8090): a gateway operator runs a VIZ node on the same or a nearby
  // box, and viz-cpp-node binds 8090/8091 (HTTP/WS RPC) + 8092/8093 (snapshot/wallet). The
  // 810x block stays clear of that range.
  const [host, portStr] = (process.env.SIGNER_LISTEN ?? "127.0.0.1:8101").split(":");
  const port = Number.parseInt(portStr ?? "8101", 10);

  const server = createServer((reqStream, res) => {
    if (reqStream.method !== "POST" || reqStream.url !== "/approve") {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const sendErr = (code: number, msg: string): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      };
      let body: string;
      try {
        body = await readLimitedBody(reqStream); // bounded size + timeout (BM4)
      } catch (err) {
        sendErr(err instanceof BodyError ? err.statusCode : 400, String(err));
        return;
      }
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
        sendErr(500, String(err));
      }
    })();
  });

  let stopRegister: (() => void) | undefined;
  server.listen(port, host, () => {
    console.log(
      `[signer] operator=${operatorId} listening on ${host}:${port} (federation ${cfg.federation.threshold}-of-${cfg.federation.n})`,
    );
    stopRegister = startRegisterLoop({
      coordinatorUrl: cfg.coordinator.url,
      operatorId,
      advertiseUrl: cfg.signerAdvertiseUrl,
      wif: cfg.viz.signingWif,
      heartbeatMs: cfg.registration.heartbeatMs,
    });
  });

  const shutdown = () => {
    stopRegister?.();
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
