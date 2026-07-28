import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { parseManifest, loadConfig } from "../src/config";

// The manifest can pin the federation-critical constants (GRAM addresses, VIZ gate accounts) and
// default RPC endpoints, so a fresh operator boots on mainnet from just the committed manifest.
// Precedence: consensus-critical values (accounts/gram) — manifest WINS over env; RPC endpoints —
// env OVERRIDES the manifest default (F2 operator-chosen). Lock both directions.

// --- parseManifest: new pinned sections ---
test("parseManifest parses gram/accounts/rpc; array rpc normalizes to a csv string", () => {
  const m = parseManifest({
    n: 1, threshold: 1, operators: [{ id: "op-1" }],
    accounts: { gram: "gram.gate", solana: "solana.gate", fees: "fees.gate" },
    gram: { jettonMinterAddress: "MINT", multisigAddress: "MS", gatewayJettonWallet: "JW" },
    rpc: { vizNodeUrls: ["https://a", "https://b"], gramEndpoints: "https://t", gramOrbsFallback: true },
  });
  assert.equal(m.accounts?.gram, "gram.gate");
  assert.equal(m.accounts?.fees, "fees.gate");
  assert.equal(m.gram?.jettonMinterAddress, "MINT");
  assert.equal(m.gram?.multisigAddress, "MS");
  assert.equal(m.rpc?.vizNodeUrls, "https://a,https://b"); // array -> csv
  assert.equal(m.rpc?.gramEndpoints, "https://t"); // string passes through
  assert.equal(m.rpc?.gramOrbsFallback, true);
});

test("parseManifest leaves the new sections undefined when a legacy manifest omits them", () => {
  const m = parseManifest({ n: 1, threshold: 1, operators: [{ id: "op-1" }] });
  assert.equal(m.gram, undefined);
  assert.equal(m.accounts, undefined);
  assert.equal(m.rpc, undefined);
});

// --- loadConfig precedence via a temp manifest file ---
const TMP = "./test-manifest-defaults.tmp.json";
const KEYS = [
  "VIZ_NODE_URL", "VIZ_NODE_WS", "GRAM_ENDPOINT", "GRAM_ORBS_FALLBACK",
  "VIZ_GATEWAY_ACCOUNT_GRAM", "VIZ_GATEWAY_ACCOUNT_SOLANA", "FEES_GATE_ACCOUNT",
  "GRAM_JETTON_MINTER_ADDRESS", "GRAM_MULTISIG_ADDRESS", "GRAM_GATEWAY_JETTON_WALLET",
  "FEDERATION_MANIFEST",
];
function withManifest(manifest: unknown, env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  writeFileSync(TMP, JSON.stringify(manifest));
  process.env.FEDERATION_MANIFEST = TMP;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    fn();
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(TMP, { force: true });
  }
}

const MANIFEST = {
  n: 1, threshold: 1, operators: [{ id: "op-1" }],
  accounts: { gram: "gram.gate", solana: "solana.gate", fees: "fees.gate" },
  gram: { jettonMinterAddress: "MINT_M", multisigAddress: "MS_M", gatewayJettonWallet: "JW_M" },
  rpc: { vizNodeUrls: ["https://m1", "https://m2", "https://m3"], gramEndpoints: ["https://tc"], gramOrbsFallback: true },
};

test("manifest supplies RPC + accounts + gram addresses when env is unset (bare boot)", () => {
  withManifest(MANIFEST, {}, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.viz.nodeUrls, ["https://m1", "https://m2", "https://m3"]);
    assert.deepEqual(cfg.gram.endpoints, ["https://tc"]);
    assert.equal(cfg.gram.orbsFallback, true);
    assert.equal(cfg.viz.gatewayAccounts.GRAM, "gram.gate");
    assert.equal(cfg.feesGateAccount, "fees.gate");
    assert.equal(cfg.gram.jettonMinterAddress, "MINT_M");
    assert.equal(cfg.gram.multisigAddress, "MS_M");
    assert.equal(cfg.gram.gatewayJettonWallet, "JW_M");
  });
});

test("env OVERRIDES the manifest for RPC endpoints (F2 operator-chosen)", () => {
  withManifest(MANIFEST, {
    VIZ_NODE_URL: "https://env-only",
    GRAM_ENDPOINT: "https://env-tc",
    GRAM_ORBS_FALLBACK: "false",
  }, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.viz.nodeUrls, ["https://env-only"], "env VIZ_NODE_URL wins over manifest");
    assert.deepEqual(cfg.gram.endpoints, ["https://env-tc"], "env GRAM_ENDPOINT wins over manifest");
    assert.equal(cfg.gram.orbsFallback, false, "env GRAM_ORBS_FALLBACK wins over manifest");
  });
});

test("manifest WINS over env for consensus-critical accounts + GRAM addresses", () => {
  // A hostile/mis-set per-box env must NOT be able to point this signer at a different contract
  // or backing account — the pinned manifest value is authoritative.
  withManifest(MANIFEST, {
    VIZ_GATEWAY_ACCOUNT_GRAM: "evil.gate",
    FEES_GATE_ACCOUNT: "evil.fees",
    GRAM_MULTISIG_ADDRESS: "EVIL_MS",
    GRAM_JETTON_MINTER_ADDRESS: "EVIL_MINT",
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.viz.gatewayAccounts.GRAM, "gram.gate", "manifest account wins over env");
    assert.equal(cfg.feesGateAccount, "fees.gate", "manifest fees account wins over env");
    assert.equal(cfg.gram.multisigAddress, "MS_M", "manifest multisig wins over env");
    assert.equal(cfg.gram.jettonMinterAddress, "MINT_M", "manifest minter wins over env");
  });
});