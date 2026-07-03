import { readFileSync, existsSync } from "node:fs";
import type { CapPolicy } from "./caps";
import type { PegInFeePolicy } from "./fees";
import type { FederationManifest, ManifestFees, OperatorRef, RemoteChainId } from "./types";

/**
 * Shared fee constants. For the multisig to merge signatures, every operator must
 * derive the SAME net, so these MUST be identical across operators — keep them in
 * the committed federation manifest / shared env, never diverge per-operator.
 * Per-chain values cover the different rent (Solana ATA vs TON jetton-wallet).
 */
export interface GatewayFeeConfig {
  floorMilliViz: bigint;
  bps: number;
  activationSurchargeMilliViz: Record<RemoteChainId, bigint>;
  mintGasFloorMilliViz: Record<RemoteChainId, bigint>;
}

/** Build the per-chain PegInFeePolicy the fee math consumes. */
export function pegInFeePolicyFor(fees: GatewayFeeConfig, chain: RemoteChainId): PegInFeePolicy {
  return {
    floorMilliViz: fees.floorMilliViz,
    bps: fees.bps,
    activationSurchargeMilliViz: fees.activationSurchargeMilliViz[chain],
    mintGasFloorMilliViz: fees.mintGasFloorMilliViz[chain],
  };
}

export interface GatewayConfig {
  service: string;
  operatorId: string;
  federation: FederationManifest;
  viz: {
    nodeUrl: string;
    gatewayAccount: string;
    signingWif: string;
    extraConfirmations: number;
  };
  ton: {
    endpoint: string;
    apiKey: string;
    multisigAddress: string;
    jettonMinterAddress: string;
    gatewayJettonWallet: string;
    signerMnemonic: string;
    finalityConfirmations: number;
    scanMaxTransactions: number; // txs fetched per peg-out scan (RPC rate-limit tuning)
    approveMaxWaitMs: number; // max wait for a proposed order / approval to land on-chain
    approvePollIntervalMs: number; // poll cadence while waiting for the above
    orderValueNano: number; // TON (nano) the proposer attaches to new_order
  };
  solana: {
    rpcUrl: string;
    wvizMint: string;
    gatewayTokenAccount: string;
    finalitySlots: number;
    multisig: string; // SPL multisig = mint authority (base58)
    nonceAccount: string; // durable nonce account (base58)
    signers: string[]; // multisig member pubkeys (base58)
    signerSecret: Uint8Array | null; // THIS operator's solana key (for signing approvals)
    submitterSecret: Uint8Array | null; // fee payer + nonce authority (proposer/submitter)
    scanMaxSignatures: number; // signatures fetched per scan (RPC rate-limit tuning)
    scanTxDelayMs: number; // delay between per-tx parses (429 avoidance)
    scanAddressBatch: number; // deposit addresses scanned per peg-out loop (rotation)
    submitterMinLamports: number; // reserve alert floor for the submitter SOL balance
    // Public program ID of the burn-only deposit program. Deposit addresses are
    // PDA(["deposit", vizAccount], programId) — publicly re-derivable, no secret. Required
    // wherever Solana peg-out is handled (lookup, scanner, and any signer validating peg-out).
    depositProgramId: string;
    lookupListen: string; // host:port for the deposit-address lookup service
  };
  coordinator: { url: string; listen: string; signerEndpoints: string[] };
  dispatcher: {
    intervalMs: number;
    retryIntervalMs: number;
    windowMs: number;
    /** SIGNING-orphan recovery timeout, per direction (mint confirms slower than a VIZ release). */
    signingTimeoutMs: { pegIn: number; pegOut: number };
    /** Alert when a release/refund row stays undelivered this long (a degraded federation). */
    staleDeliveryAlertMs: number;
  };
  /** Service VIZ account that collects swept peg-in fees (single-key, no multisig). */
  feesGateAccount: string;
  caps: CapPolicy;
  fees: GatewayFeeConfig;
  storeUrl: string;
  recon: { intervalMs: number; driftToleranceMilliViz: bigint };
}

function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
}

function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} is not an integer: ${v}`);
  return n;
}

function big(name: string, dflt: string): bigint {
  return BigInt(opt(name, dflt));
}

/** Parse a solana-keygen JSON byte-array secret into bytes (null if unset). */
function solanaSecret(name: string): Uint8Array | null {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return null;
  if (!v.trim().startsWith("[")) {
    throw new Error(`${name} must be a JSON byte array (solana-keygen format).`);
  }
  return Uint8Array.from(JSON.parse(v) as number[]);
}

/**
 * Parse a federation manifest object (the committed federation.json). The
 * running gateway reads this to know the operator set + their pubkeys; the
 * rotation tool rewrites it after a successful rotation.
 */
export function parseManifest(raw: unknown): FederationManifest {
  const o = raw as Record<string, unknown>;
  const n = Number(o["n"]);
  const threshold = Number(o["threshold"]);
  const opsRaw = o["operators"];
  if (!Array.isArray(opsRaw)) throw new Error("federation manifest: operators must be an array");
  const operators: OperatorRef[] = opsRaw.map((x, i) => {
    const e = x as Record<string, unknown>;
    const id = String(e["id"] ?? "");
    const vizPubkey = String(e["vizPubkey"] ?? "");
    const tonPubkey = String(e["tonPubkey"] ?? "");
    const solanaPubkey = String(e["solanaPubkey"] ?? "");
    if (!id) throw new Error(`federation manifest: operators[${i}] missing id`);
    return { id, vizPubkey, tonPubkey, solanaPubkey };
  });
  if (!Number.isInteger(n) || !Number.isInteger(threshold)) {
    throw new Error("federation manifest: n and threshold must be integers");
  }
  if (operators.length !== n) {
    throw new Error(`federation manifest: operators.length ${operators.length} != n ${n}`);
  }
  if (threshold <= 0 || threshold > n) {
    throw new Error(`federation manifest: threshold ${threshold} must be in 1..${n}`);
  }
  let fees: ManifestFees | undefined;
  if (o["fees"] !== undefined) {
    const f = o["fees"] as Record<string, unknown>;
    const act = f["activationSurchargeMilliViz"] as Record<string, unknown>;
    const gas = f["mintGasFloorMilliViz"] as Record<string, unknown>;
    fees = {
      floorMilliViz: BigInt(f["floorMilliViz"] as number),
      bps: Number(f["bps"]),
      activationSurchargeMilliViz: { SOLANA: BigInt(act["SOLANA"] as number), TON: BigInt(act["TON"] as number) },
      mintGasFloorMilliViz: { SOLANA: BigInt(gas["SOLANA"] as number), TON: BigInt(gas["TON"] as number) },
    };
  }
  return { n, threshold, operators, fees };
}

/** Load and validate config from environment. Throws on invalid federation. */
export function loadConfig(): GatewayConfig {
  // Defaults to 1-of-1 for a solo bootstrap launch. Grow by adding signer keys
  // (yours or validators') and raising the threshold — no redeploy required.
  const n = int("FEDERATION_N", 1);
  const threshold = int("FEDERATION_THRESHOLD", 1);
  if (threshold <= 0 || threshold > n) {
    throw new Error(`Invalid federation: threshold ${threshold} must be in 1..${n}`);
  }
  if (threshold <= Math.floor(n / 2)) {
    // Not fatal, but a custody bridge should require a strict majority.
    console.warn(
      `[config] WARNING: threshold ${threshold}-of-${n} is not a strict majority; theft tolerance is only ${threshold - 1}.`,
    );
  }

  // Prefer a committed manifest (operator pubkeys); fall back to count-only
  // synthesis so a fresh 1-of-1 bootstrap still boots before any rotation.
  const manifestPath = opt("FEDERATION_MANIFEST", "./federation.json");
  let federation: FederationManifest;
  if (existsSync(manifestPath)) {
    federation = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (federation.threshold <= Math.floor(federation.n / 2)) {
      console.warn(
        `[config] WARNING: threshold ${federation.threshold}-of-${federation.n} is not a strict majority; theft tolerance is only ${federation.threshold - 1}.`,
      );
    }
  } else {
    const operators: OperatorRef[] = Array.from({ length: n }, (_, i) => ({
      id: `op-${i + 1}`,
      vizPubkey: "",
      tonPubkey: "",
      solanaPubkey: "",
    }));
    federation = { n, threshold, operators };
  }

  return {
    service: opt("SERVICE", "signer"),
    operatorId: opt("OPERATOR_ID", "op-1"),
    federation,
    viz: {
      // Accepts http(s):// or ws(s)://; viz-js-lib picks the transport from the scheme.
      nodeUrl: opt("VIZ_NODE_URL", opt("VIZ_NODE_WS", "https://node.viz.cx")),
      gatewayAccount: opt("VIZ_GATEWAY_ACCOUNT", "viz-gateway"),
      signingWif: opt("VIZ_SIGNING_WIF", ""),
      extraConfirmations: int("VIZ_EXTRA_CONFIRMATIONS", 2),
    },
    ton: {
      endpoint: opt("TON_ENDPOINT", "https://toncenter.com/api/v2/jsonRPC"),
      apiKey: opt("TON_API_KEY", ""),
      multisigAddress: opt("TON_MULTISIG_ADDRESS", ""),
      jettonMinterAddress: opt("TON_JETTON_MINTER_ADDRESS", ""),
      gatewayJettonWallet: opt("TON_GATEWAY_JETTON_WALLET", ""),
      signerMnemonic: opt("TON_SIGNER_MNEMONIC", ""),
      finalityConfirmations: int("TON_FINALITY_CONFIRMATIONS", 1),
      scanMaxTransactions: int("TON_MAX_TRANSACTIONS", 20),
      // The proposer sends new_order then waits for the Order contract to deploy; an
      // approver waits for its vote to reflect. Testnet inclusion + toncenter view lag
      // can exceed the 60s default, so this is tunable for live runs.
      approveMaxWaitMs: int("TON_APPROVE_MAX_WAIT_MS", 60000),
      approvePollIntervalMs: int("TON_APPROVE_POLL_INTERVAL_MS", 3000),
      // TON (nano) the proposer attaches to a new_order. Funds the Order contract:
      // deploy gas + the mint action's own value (~0.1) + margin; surplus flows to the
      // multisig on execution, not back to the proposer. 1 TON default is conservative;
      // lower it to reduce proposer drain when funding is tight (each order costs ~this).
      orderValueNano: int("TON_ORDER_VALUE_NANO", 1_000_000_000),
    },
    solana: {
      rpcUrl: opt("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
      wvizMint: opt("SOLANA_WVIZ_MINT", ""),
      gatewayTokenAccount: opt("SOLANA_GATEWAY_TOKEN_ACCOUNT", ""),
      finalitySlots: int("SOLANA_FINALITY_SLOTS", 0),
      multisig: opt("SOLANA_MULTISIG", ""),
      nonceAccount: opt("SOLANA_NONCE_ACCOUNT", ""),
      signers: opt("SOLANA_SIGNERS", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      signerSecret: solanaSecret("SOLANA_SIGNER_SECRET"),
      submitterSecret: solanaSecret("SOLANA_SUBMITTER_SECRET"),
      scanMaxSignatures: int("SOLANA_MAX_SIGNATURES", 25),
      scanTxDelayMs: int("SOLANA_RPC_TX_DELAY_MS", 250),
      scanAddressBatch: int("SOLANA_SCAN_ADDRESS_BATCH", 50),
      submitterMinLamports: int("SOLANA_SUBMITTER_MIN_LAMPORTS", 50_000_000), // ~0.05 SOL
      depositProgramId: opt("SOLANA_DEPOSIT_PROGRAM_ID", ""),
      lookupListen: opt("LOOKUP_LISTEN", "127.0.0.1:8095"),
    },
    coordinator: {
      url: opt("COORDINATOR_URL", "http://coordinator:8080"),
      listen: opt("COORDINATOR_LISTEN", "0.0.0.0:8080"),
      // Signer /approve endpoints the coordinator calls. Solo: one local signer.
      signerEndpoints: opt("SIGNER_ENDPOINTS", "http://signer:8090")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    // Dispatcher: drains QUEUED outbox rows to the coordinator with retries.
    // P3 policy: retry every 10s for 3 min, then REFUND. intervalMs is the loop tick.
    dispatcher: {
      intervalMs: int("DISPATCHER_INTERVAL_MS", 5000),
      retryIntervalMs: int("DISPATCHER_RETRY_INTERVAL_MS", 10000),
      windowMs: int("DISPATCHER_WINDOW_MS", 180000),
      // A row stuck in SIGNING longer than this (a crashed delivery) is requeued.
      // MUST exceed the worst-case coordinator round-trip (sign + broadcast + confirm)
      // for that direction, or a slow-but-legit confirm gets spuriously requeued —
      // which, until delivery is idempotent (the broadcast-boundary check, separate
      // work item), risks a double mint/release. Per-direction because a remote mint
      // (TON masterchain / Solana finality) confirms slower than a VIZ release.
      // DISPATCHER_SIGNING_TIMEOUT_MS sets a single fallback for both.
      signingTimeoutMs: {
        pegIn: int("DISPATCHER_SIGNING_TIMEOUT_PEG_IN_MS", int("DISPATCHER_SIGNING_TIMEOUT_MS", 300000)),
        pegOut: int("DISPATCHER_SIGNING_TIMEOUT_PEG_OUT_MS", int("DISPATCHER_SIGNING_TIMEOUT_MS", 180000)),
      },
      // A release/refund retries forever (nothing to refund), so a row wedged this long
      // means the federation can't sign — alert operators rather than fail silently.
      staleDeliveryAlertMs: int("DISPATCHER_STALE_ALERT_MS", 3600000), // 1h
    },
    feesGateAccount: opt("FEES_GATE_ACCOUNT", "fees.gate"),
    // Conservative bootstrap caps (1 VIZ ~ $0.005): $500 / $1,000 / $10,000.
    // Raise as TVL and the federation grow.
    caps: {
      perTxMilliViz: big("CAP_PER_TX_MILLI_VIZ", "200000000"), // 200,000 VIZ (~$1,000)
      rolling24hMilliViz: big("CAP_24H_MILLI_VIZ", "2000000000"), // 2,000,000 VIZ (~$10,000)
      manualReviewAboveMilliViz: big("MANUAL_REVIEW_ABOVE_MILLI_VIZ", "100000000"), // 100,000 VIZ (~$500)
    },
    // Peg-in fee held in VIZ: base = max(10 VIZ, 0.20%); + per-chain activation
    // surcharge when the destination isn't provisioned (Solana ATA / TON jetton-wallet
    // rent). net = gross − fee must cover the per-chain mint-gas floor, else refund.
    // Manifest values take precedence over env vars — use the manifest for production
    // so all operators always agree; env vars remain useful for local testing.
    fees: {
      floorMilliViz: federation.fees?.floorMilliViz ?? big("FEE_FLOOR_MILLI_VIZ", "10000"),
      bps: federation.fees?.bps ?? int("FEE_BPS", 20),
      activationSurchargeMilliViz: {
        SOLANA: federation.fees?.activationSurchargeMilliViz.SOLANA ?? big("FEE_ACTIVATION_SOLANA_MILLI_VIZ", "10000"),
        TON: federation.fees?.activationSurchargeMilliViz.TON ?? big("FEE_ACTIVATION_TON_MILLI_VIZ", "10000"),
      },
      mintGasFloorMilliViz: {
        SOLANA: federation.fees?.mintGasFloorMilliViz.SOLANA ?? big("MINT_GAS_FLOOR_SOLANA_MILLI_VIZ", "1000"),
        TON: federation.fees?.mintGasFloorMilliViz.TON ?? big("MINT_GAS_FLOOR_TON_MILLI_VIZ", "1000"),
      },
    },
    storeUrl: opt("STORE_URL", "sqlite:./data/gateway.sqlite"),
    recon: {
      intervalMs: int("RECON_INTERVAL_MS", 30000),
      driftToleranceMilliViz: big("RECON_DRIFT_TOLERANCE_MILLI_VIZ", "0"),
    },
  };
}
