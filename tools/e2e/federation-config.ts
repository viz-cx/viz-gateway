// tools/e2e/federation-config.ts — config loader for the N-of-M federation harness.
//
// Env vars (all required unless noted):
//   FED_N              — total operator count (e.g. 3)
//   FED_THRESHOLD      — signing threshold (e.g. 2)
//   FED_BASE_PORT      — first signer port; subsequent signers get +1, +2, … (default 8091)
//   FED_OP<i>_ID       — operator id for signer i (1-indexed, e.g. FED_OP1_ID=op-1)
//   FED_OP<i>_WIF      — VIZ signing WIF for signer i
//   FED_OP<i>_SOLANA_SECRET  — (optional) Solana signer secret for signer i
//
// Shared env vars consumed from the calling environment (same as launchStack):
//   VIZ_NODE_URL, VIZ_GATEWAY_ACCOUNT, STORE_URL, COORDINATOR_LISTEN, COORDINATOR_URL
//   (passed through from the parent e2e runEnv or process.env)

import type { SignerSpec } from "./stack";

export interface FederationConfig {
  n: number;
  threshold: number;
  basePort: number;
  operators: Array<{
    id: string;
    wif: string;
    solanaSecret?: string;
  }>;
}

export interface FederationRunEnv {
  signerSpecs: SignerSpec[];
  coordinatorEnv: Record<string, string>;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing required federation var: ${name}`);
  return v;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] || undefined;
}

export function loadFederationConfig(env: NodeJS.ProcessEnv): FederationConfig {
  const n = Number.parseInt(req(env, "FED_N"), 10);
  const threshold = Number.parseInt(req(env, "FED_THRESHOLD"), 10);
  const basePort = Number.parseInt(env["FED_BASE_PORT"] ?? "8091", 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`FED_N must be a positive integer, got: ${env["FED_N"]}`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > n)
    throw new Error(`FED_THRESHOLD must be in 1..${n}, got: ${env["FED_THRESHOLD"]}`);

  const operators: FederationConfig["operators"] = [];
  for (let i = 1; i <= n; i++) {
    const id = req(env, `FED_OP${i}_ID`);
    const wif = req(env, `FED_OP${i}_WIF`);
    const solanaSecret = opt(env, `FED_OP${i}_SOLANA_SECRET`);
    operators.push({ id, wif, solanaSecret });
  }

  return { n, threshold, basePort, operators };
}

export function buildFederationRunEnv(
  cfg: FederationConfig,
  sharedEnv: Record<string, string>,
): FederationRunEnv {
  const signerSpecs: SignerSpec[] = cfg.operators.map((op, idx) => {
    const port = cfg.basePort + idx;
    const env: Record<string, string> = {
      ...sharedEnv,
      OPERATOR_ID: op.id,
      VIZ_SIGNING_WIF: op.wif,
      FEDERATION_N: String(cfg.n),
      FEDERATION_THRESHOLD: String(cfg.threshold),
      SIGNER_LISTEN: `127.0.0.1:${port}`,
    };
    if (op.solanaSecret) env["SOLANA_SIGNER_SECRET"] = op.solanaSecret;
    return { operatorId: op.id, port, env };
  });

  const coordinatorEnv: Record<string, string> = {
    ...sharedEnv,
    FEDERATION_N: String(cfg.n),
    FEDERATION_THRESHOLD: String(cfg.threshold),
    // SIGNER_ENDPOINTS is assembled by launchFederationStack from signerSpecs.
  };

  return { signerSpecs, coordinatorEnv };
}
