import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayAccounts } from "@gateway/common";

test("GRAM action → from = gram.gate", () => {
  const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  const from = accounts.accountFor("GRAM");
  assert.equal(from, "gram.gate");
});

test("SOLANA action → from = solana.gate", () => {
  const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  const from = accounts.accountFor("SOLANA");
  assert.equal(from, "solana.gate");
});

test("missing remoteChain on release action throws", () => {
  const action = { id: "x", remoteChain: undefined };
  assert.throws(() => {
    if (!action.remoteChain) throw new Error(`release ${action.id} missing remoteChain — cannot select backing account`);
  }, /missing remoteChain/);
});
