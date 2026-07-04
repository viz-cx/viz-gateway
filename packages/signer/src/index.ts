import { createServer } from "node:http";
import {
  actionFromWire,
  createStore,
  loadConfig,
  type SolanaMintProposal,
  type TonMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";
import { TonApprover } from "@gateway/ton-watcher/dist/tonApprove";
import { KeyedSigner } from "./keyedSigner";
import { routeApproval } from "./routeApproval";
import { validateAction, type BurnReader, type SourceValidatorDeps } from "./sourceValidator";

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
  const store = createStore(cfg.storeUrl);

  // F2 INDEPENDENCE LINCHPIN: these readers MUST point at the operator's OWN nodes
  // (VIZ_NODE_URL / SOLANA_RPC_URL), never a coordinator-fed endpoint. They re-derive
  // the source event so a compromised coordinator cannot forge a (action, proposal) pair.
  const vizChain = new VizJsChain(cfg.viz.nodeUrl, cfg.viz.gatewayAccount);
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
  const tonReader: BurnReader = cfg.ton.gatewayJettonWallet
    ? new TonHttpChain(
        cfg.ton.endpoint,
        cfg.ton.apiKey,
        cfg.ton.jettonMinterAddress,
        cfg.ton.gatewayJettonWallet,
        "", // multisigAddress (read-only reader; order reads not needed here)
        cfg.ton.finalityConfirmations,
        cfg.ton.scanMaxTransactions,
      )
    : {
        async getBurn() {
          throw new Error(
            "TON not configured on this signer (TON_GATEWAY_JETTON_WALLET unset); refusing TON peg-out",
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
  };

  // Pin the Solana accounts to this operator's own config so a compromised coordinator
  // can't redirect a mint (only meaningful once Solana is wired: SOLANA_WVIZ_MINT set).
  const solanaPins = cfg.solana.wvizMint
    ? { mint: cfg.solana.wvizMint, multisig: cfg.solana.multisig, nonceAccount: cfg.solana.nonceAccount }
    : null;

  // TON on-chain approver (Phase B): performs this operator's propose/approve from its
  // OWN wallet + node. Wired only when TON is fully configured on this operator; a TON
  // PEG_IN without it is refused (KeyedSigner throws) rather than silently unauthorized.
  const tonApprover =
    cfg.ton.jettonMinterAddress && cfg.ton.multisigAddress && cfg.ton.signerMnemonic
      ? new TonApprover(
          cfg.ton.endpoint,
          cfg.ton.apiKey,
          cfg.ton.jettonMinterAddress,
          cfg.ton.multisigAddress,
          cfg.ton.signerMnemonic,
          {
            maxWaitMs: cfg.ton.approveMaxWaitMs,
            pollIntervalMs: cfg.ton.approvePollIntervalMs,
            orderValueNano: BigInt(cfg.ton.orderValueNano),
          },
        )
      : null;

  const signer = new KeyedSigner(
    cfg.operatorId,
    cfg.viz.signingWif,
    cfg.ton.signerMnemonic,
    cfg.fees,
    cfg.solana.signerSecret,
    (action) => validateAction(action, validatorDeps),
    solanaPins,
    tonApprover,
  );
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
