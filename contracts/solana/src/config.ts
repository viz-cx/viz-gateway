import { Keypair, PublicKey } from "@solana/web3.js";

function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
}
function list(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return Number.parseInt(v, 10);
}

export interface SolanaDeployConfig {
  rpcUrl: string;
  payer: Keypair | null; // required only to APPLY
  signers: PublicKey[]; // SPL multisig signer pubkeys (operator wallets)
  threshold: number; // M of N
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  apply: boolean;
}

/** Payer secret as a solana-keygen JSON byte array (avoid base58 to skip a dep). */
function loadPayer(secret: string): Keypair | null {
  if (!secret) return null;
  if (!secret.trim().startsWith("[")) {
    throw new Error("SOLANA_PAYER_SECRET must be a JSON byte array (solana-keygen format).");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
}

export function loadSolanaDeployConfig(): SolanaDeployConfig {
  return {
    rpcUrl: opt("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    payer: loadPayer(opt("SOLANA_PAYER_SECRET", "")),
    signers: list(opt("SOLANA_SIGNERS", "")).map((s) => new PublicKey(s)),
    threshold: int("SOLANA_THRESHOLD", 1),
    decimals: int("WVIZ_DECIMALS", 3),
    name: opt("WVIZ_NAME", "Wrapped VIZ"),
    symbol: opt("WVIZ_SYMBOL", "wVIZ"),
    uri: opt(
      "WVIZ_URI",
      "https://raw.githubusercontent.com/viz-cx/viz-gateway/main/metadata/wviz.json",
    ),
    apply: opt("DEPLOY_SEND", "0") === "1",
  };
}

function loadSecret(name: string): Uint8Array | null {
  const v = opt(name, "");
  if (!v) return null;
  if (!v.trim().startsWith("[")) {
    throw new Error(`${name} must be a JSON byte array (solana-keygen format).`);
  }
  return Uint8Array.from(JSON.parse(v) as number[]);
}

export interface SolanaRotationConfig {
  rpcUrl: string;
  oldMultisig: string; // SOLANA_MULTISIG (current mint+freeze authority)
  mint: string; // SOLANA_WVIZ_MINT
  nonceAccount: string; // SOLANA_ROTATION_NONCE_ACCOUNT
  submitterSecret: Uint8Array | null; // fee payer + nonce authority + Phase-A payer
  signerSecret: Uint8Array | null; // this operator's member key (co-sign)
  chainId: string; // ROTATION_CHAIN_ID
  apply: boolean; // APPLY=1
}

export function loadSolanaRotationConfig(): SolanaRotationConfig {
  return {
    rpcUrl: opt("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    oldMultisig: opt("SOLANA_MULTISIG", ""),
    mint: opt("SOLANA_WVIZ_MINT", ""),
    nonceAccount: opt("SOLANA_ROTATION_NONCE_ACCOUNT", ""),
    submitterSecret: loadSecret("SOLANA_SUBMITTER_SECRET"),
    signerSecret: loadSecret("SOLANA_SIGNER_SECRET"),
    chainId: opt("ROTATION_CHAIN_ID", "viz-gateway"),
    apply: opt("APPLY", "0") === "1",
  };
}
