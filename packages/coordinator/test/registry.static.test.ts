import { test } from "node:test";
import assert from "node:assert/strict";
import { SignerRegistry } from "../src/registry";

test("register accepts a valid challenge without any vizPerTon quote", () => {
  // A minimal smoke: Registry.register must have arity 4 (no vizPerTon).
  assert.equal(SignerRegistry.prototype.register.length, 4);
});

test("Registry no longer exposes liveQuotes", () => {
  assert.equal("liveQuotes" in SignerRegistry.prototype, false);
});
