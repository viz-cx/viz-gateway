import { writeFileSync, mkdirSync } from "node:fs";
import viz from "viz-js-lib";

export interface E2eConfig {
  chain: "gram" | "solana";
  runId: string;
  freshStore: boolean;
  viz: {
    nodeUrl: string;
    testWif: string;
    testAccount: string;
    gatewayAccount: string;
    gatewayWif: string;
    recipient: string;
    minBalanceMilliViz: bigint;
  };
  gram: {
    endpoint: string;
    apiKey: string;
    gatewayJettonWallet: string;
    gatewayOwner: string;
    jettonMinterAddress: string;
    multisigAddress: string;
    signerMnemonic: string;
    burnMnemonic: string;
    burnOwner: string;
    minGasNano: bigint;
  };
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`missing required E2E var: ${name}`);
  return v;
}

function makeRunId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-${ts}-${rand}`;
}

export function loadE2eConfig(env: NodeJS.ProcessEnv, chain: "gram" | "solana"): E2eConfig {
  const viz = {
    nodeUrl: req(env, "E2E_VIZ_NODE_URL"),
    testWif: req(env, "E2E_VIZ_TEST_WIF"),
    testAccount: req(env, "E2E_VIZ_TEST_ACCOUNT"),
    gatewayAccount: req(env, "E2E_VIZ_GATEWAY_ACCOUNT"),
    gatewayWif: req(env, "E2E_VIZ_GATEWAY_WIF"),
    recipient: req(env, "E2E_VIZ_RECIPIENT"),
    minBalanceMilliViz: BigInt(req(env, "E2E_VIZ_MIN_BALANCE_MILLI_VIZ")),
  };
  const gram = {
    endpoint: req(env, "E2E_GRAM_ENDPOINT"),
    apiKey: req(env, "E2E_GRAM_API_KEY"),
    gatewayJettonWallet: req(env, "E2E_GRAM_GATEWAY_JETTON_WALLET"),
    gatewayOwner: req(env, "E2E_GRAM_GATEWAY_OWNER"),
    jettonMinterAddress: req(env, "E2E_GRAM_JETTON_MINTER_ADDRESS"),
    multisigAddress: req(env, "E2E_GRAM_MULTISIG_ADDRESS"),
    signerMnemonic: req(env, "E2E_GRAM_SIGNER_MNEMONIC"),
    burnMnemonic: req(env, "E2E_GRAM_BURN_MNEMONIC"),
    burnOwner: req(env, "E2E_GRAM_BURN_OWNER"),
    minGasNano: BigInt(req(env, "E2E_GRAM_MIN_GAS_NANO")),
  };
  return { chain, runId: makeRunId(), freshStore: env.E2E_FRESH_STORE === "1", viz, gram };
}

export function buildRunEnv(cfg: E2eConfig): Record<string, string> {
  return {
    // VIZ — per-network backing accounts (common/config buildGatewayAccounts requires
    // BOTH chains present, non-empty, and distinct/injective). This TON harness only
    // exercises GRAM, so GRAM = the account locks are sent to (E2E_VIZ_GATEWAY_ACCOUNT)
    // and SOLANA gets a distinct, inert placeholder: the viz-watcher scans blocks
    // globally and filters by isBackingAccount(to), so an account that never receives
    // a transfer is never matched.
    VIZ_NODE_URL: cfg.viz.nodeUrl,
    VIZ_GATEWAY_ACCOUNT_GRAM: cfg.viz.gatewayAccount,
    VIZ_GATEWAY_ACCOUNT_SOLANA: `${cfg.viz.gatewayAccount}.solana-e2e-unused`,
    VIZ_SIGNING_WIF: cfg.viz.gatewayWif,
    VIZ_EXTRA_CONFIRMATIONS: "2",
    // GRAM (TON network)
    GRAM_ENDPOINT: cfg.gram.endpoint,
    GRAM_API_KEY: cfg.gram.apiKey,
    GRAM_JETTON_MINTER_ADDRESS: cfg.gram.jettonMinterAddress,
    GRAM_GATEWAY_JETTON_WALLET: cfg.gram.gatewayJettonWallet,
    GRAM_MULTISIG_ADDRESS: cfg.gram.multisigAddress,
    GRAM_SIGNER_MNEMONIC: cfg.gram.signerMnemonic,
    // Federation: solo 1-of-1
    FEDERATION_N: "1",
    FEDERATION_THRESHOLD: "1",
    // Neutralize the repo's committed ./federation.json (the real 2-of-3 mainnet
    // manifest) so the harness's FEDERATION_N/THRESHOLD govern sizing for BOTH the
    // parent and every spawned child (this shared env is spread into each). A manifest
    // file, when present, wins over FEDERATION_N — write a real 1-of-1 solo manifest
    // from the gateway WIF so SignerRegistry.idOfPubkey is populated and register()
    // succeeds. Overridden per federation below.
    FEDERATION_MANIFEST: (() => {
      const vizPubkey = viz.auth.wifToPublic(cfg.viz.gatewayWif);
      const manifest = { n: 1, threshold: 1, operators: [{ id: "op-1", vizPubkey, tonPubkey: "", solanaPubkey: "" }] };
      mkdirSync("./data", { recursive: true });
      const path = `./data/e2e-manifest-solo-${cfg.runId}.json`;
      writeFileSync(path, JSON.stringify(manifest));
      return path;
    })(),
    OPERATOR_ID: "op-1",
    // Persistent store across runs (matches production) so idempotency memory
    // survives: a peg-out burn already released on a prior run is NOT re-released
    // when it's still inside the watcher's scan window. Set E2E_FRESH_STORE=1 for
    // a clean idempotency slate keyed by runId (old per-run behaviour).
    STORE_URL: cfg.freshStore
      ? `sqlite:./data/${cfg.runId}.sqlite`
      : `sqlite:./data/e2e.sqlite`,
    // Coordinator/signer wiring (loopback, solo)
    COORDINATOR_LISTEN: "127.0.0.1:8080",
    COORDINATOR_URL: "http://127.0.0.1:8080",
    SIGNER_LISTEN: "127.0.0.1:8090",
    SIGNER_ADVERTISE_URL: "http://127.0.0.1:8090",
  };
}
