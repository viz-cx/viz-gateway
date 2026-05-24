import type { CapPolicy } from "./caps";
import type { FeePolicy } from "./fees";
import type { FederationManifest } from "./types";

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
  };
  coordinator: { url: string; listen: string; signerEndpoints: string[] };
  caps: CapPolicy;
  fees: FeePolicy;
  storeUrl: string;
  recon: { intervalMs: number; driftToleranceMilliViz: bigint };
}

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
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

  const operators = Array.from({ length: n }, (_, i) => `op-${i + 1}`);

  return {
    service: opt("SERVICE", "signer"),
    operatorId: opt("OPERATOR_ID", "op-1"),
    federation: { n, threshold, operators },
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
    // Conservative bootstrap caps (1 VIZ ~ $0.005): $500 / $1,000 / $10,000.
    // Raise as TVL and the federation grow.
    caps: {
      perTxMilliViz: big("CAP_PER_TX_MILLI_VIZ", "200000000"), // 200,000 VIZ (~$1,000)
      rolling24hMilliViz: big("CAP_24H_MILLI_VIZ", "2000000000"), // 2,000,000 VIZ (~$10,000)
      manualReviewAboveMilliViz: big("MANUAL_REVIEW_ABOVE_MILLI_VIZ", "100000000"), // 100,000 VIZ (~$500)
    },
    // Peg-in fee covers TON mint gas + margin; collected in wVIZ. Peg-out free.
    // floor 100 VIZ (~$0.50 ~ 0.25 TON); min peg-in 2,000 VIZ (~$10).
    fees: {
      flatFloorMilliViz: big("FEE_FLOOR_MILLI_VIZ", "100000"), // 100 VIZ
      bps: int("FEE_BPS", 30), // 0.30%
      minPegInMilliViz: big("MIN_PEGIN_MILLI_VIZ", "2000000"), // 2,000 VIZ
    },
    storeUrl: opt("STORE_URL", "sqlite:./data/gateway.sqlite"),
    recon: {
      intervalMs: int("RECON_INTERVAL_MS", 30000),
      driftToleranceMilliViz: big("RECON_DRIFT_TOLERANCE_MILLI_VIZ", "0"),
    },
  };
}
