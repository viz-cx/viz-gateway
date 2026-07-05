import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, buildGatewayAccounts } from "../src/config";

test("loadConfig reads per-chain gateway accounts", () => {
  process.env.VIZ_GATEWAY_ACCOUNT_GRAM = "gram.gate";
  process.env.VIZ_GATEWAY_ACCOUNT_SOLANA = "solana.gate";
  const cfg = loadConfig();
  assert.equal(cfg.viz.gatewayAccounts.GRAM, "gram.gate");
  const g = buildGatewayAccounts(cfg);
  assert.equal(g.accountFor("SOLANA"), "solana.gate");
});

test("a missing per-chain account throws at buildGatewayAccounts", () => {
  process.env.VIZ_GATEWAY_ACCOUNT_GRAM = "gram.gate";
  delete process.env.VIZ_GATEWAY_ACCOUNT_SOLANA;
  const cfg = loadConfig();
  assert.throws(() => buildGatewayAccounts(cfg), /missing|empty|SOLANA/i);
});
