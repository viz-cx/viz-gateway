import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayAccounts } from "../src/gatewayAccounts";

test("accountFor / chainFor round-trip", () => {
  const g = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  assert.equal(g.accountFor("SOLANA"), "solana.gate");
  assert.equal(g.chainFor("gram.gate"), "GRAM");
  assert.ok(g.isBackingAccount("solana.gate"));
  assert.ok(!g.isBackingAccount("fees.gate"));
  assert.deepEqual(g.all().sort(), ["gram.gate", "solana.gate"]);
});

test("chainFor throws on an unmapped account (never route a stranger deposit)", () => {
  const g = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
  assert.throws(() => g.chainFor("attacker.acct"), /unmapped/i);
});

test("injectivity: two chains sharing one account throws", () => {
  assert.throws(
    () => new GatewayAccounts({ GRAM: "shared.gate", SOLANA: "shared.gate" }),
    /distinct|shared|injective/i,
  );
});

test("totality: a missing/empty account throws", () => {
  assert.throws(() => new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "" } as any), /missing|empty/i);
});
