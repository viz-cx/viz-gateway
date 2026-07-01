export interface E2eConfig {
  chain: "ton" | "solana";
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
  ton: {
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

export function loadE2eConfig(env: NodeJS.ProcessEnv, chain: "ton" | "solana"): E2eConfig {
  const viz = {
    nodeUrl: req(env, "E2E_VIZ_NODE_URL"),
    testWif: req(env, "E2E_VIZ_TEST_WIF"),
    testAccount: req(env, "E2E_VIZ_TEST_ACCOUNT"),
    gatewayAccount: req(env, "E2E_VIZ_GATEWAY_ACCOUNT"),
    gatewayWif: req(env, "E2E_VIZ_GATEWAY_WIF"),
    recipient: req(env, "E2E_VIZ_RECIPIENT"),
    minBalanceMilliViz: BigInt(req(env, "E2E_VIZ_MIN_BALANCE_MILLI_VIZ")),
  };
  const ton = {
    endpoint: req(env, "E2E_TON_ENDPOINT"),
    apiKey: req(env, "E2E_TON_API_KEY"),
    gatewayJettonWallet: req(env, "E2E_TON_GATEWAY_JETTON_WALLET"),
    gatewayOwner: req(env, "E2E_TON_GATEWAY_OWNER"),
    jettonMinterAddress: req(env, "E2E_TON_JETTON_MINTER_ADDRESS"),
    multisigAddress: req(env, "E2E_TON_MULTISIG_ADDRESS"),
    signerMnemonic: req(env, "E2E_TON_SIGNER_MNEMONIC"),
    burnMnemonic: req(env, "E2E_TON_BURN_MNEMONIC"),
    burnOwner: req(env, "E2E_TON_BURN_OWNER"),
    minGasNano: BigInt(req(env, "E2E_TON_MIN_GAS_NANO")),
  };
  return { chain, runId: makeRunId(), freshStore: env.E2E_FRESH_STORE === "1", viz, ton };
}

export function buildRunEnv(cfg: E2eConfig): Record<string, string> {
  return {
    // VIZ
    VIZ_NODE_URL: cfg.viz.nodeUrl,
    VIZ_GATEWAY_ACCOUNT: cfg.viz.gatewayAccount,
    VIZ_SIGNING_WIF: cfg.viz.gatewayWif,
    VIZ_EXTRA_CONFIRMATIONS: "2",
    // TON
    TON_ENDPOINT: cfg.ton.endpoint,
    TON_API_KEY: cfg.ton.apiKey,
    TON_JETTON_MINTER_ADDRESS: cfg.ton.jettonMinterAddress,
    TON_GATEWAY_JETTON_WALLET: cfg.ton.gatewayJettonWallet,
    TON_MULTISIG_ADDRESS: cfg.ton.multisigAddress,
    TON_SIGNER_MNEMONIC: cfg.ton.signerMnemonic,
    // Federation: solo 1-of-1
    FEDERATION_N: "1",
    FEDERATION_THRESHOLD: "1",
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
    SIGNER_ENDPOINTS: "http://127.0.0.1:8090",
  };
}
