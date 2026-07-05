import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayAccounts, validateRemoteAddress } from "@gateway/common";

test("backing account routes to correct chain", () => {
  const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  assert.equal(accounts.chainFor("solana.gate"), "SOLANA");
  assert.equal(accounts.chainFor("gram.gate"), "GRAM");
  assert.ok(accounts.isBackingAccount("gram.gate"));
  assert.ok(accounts.isBackingAccount("solana.gate"));
  assert.ok(!accounts.isBackingAccount("random.acct"));
});

test("accountFor resolves chain to account", () => {
  const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  assert.equal(accounts.accountFor("SOLANA"), "solana.gate");
  assert.equal(accounts.accountFor("GRAM"), "gram.gate");
});

test("chainFor throws on unmapped account", () => {
  const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  assert.throws(
    () => accounts.chainFor("unknown.acct"),
    /unmapped account|refusing to route/i,
  );
});

test("duplicate backing account is rejected at construction", () => {
  assert.throws(
    () => new GatewayAccounts({ GRAM: "shared.gate", SOLANA: "shared.gate" }),
    /distinct|injective|maps to both/i,
  );
});

test("address-only memo validated per chain - valid SOLANA address passes", () => {
  assert.doesNotThrow(() =>
    validateRemoteAddress("SOLANA", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
});

test("address-only memo validated per chain - valid GRAM address passes", () => {
  assert.doesNotThrow(() =>
    validateRemoteAddress("GRAM", "EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG"),
  );
});

test("address with colon is rejected for SOLANA", () => {
  assert.throws(
    () => validateRemoteAddress("SOLANA", "has:colon"),
    /invalid|colon|':'/i,
  );
});

test("address with colon is rejected for GRAM", () => {
  assert.throws(
    () => validateRemoteAddress("GRAM", "GRAM:EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG"),
    /invalid|colon|':'/i,
  );
});

test("empty memo is rejected", () => {
  assert.throws(
    () => validateRemoteAddress("SOLANA", ""),
    /empty/i,
  );
});

test("malformed SOLANA address is rejected", () => {
  assert.throws(
    () => validateRemoteAddress("SOLANA", "not-a-valid-solana-address!"),
    /invalid/i,
  );
});

test("malformed GRAM address is rejected", () => {
  assert.throws(
    () => validateRemoteAddress("GRAM", "notAGramAddress"),
    /invalid/i,
  );
});
