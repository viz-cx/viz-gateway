import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegOut } from "../src/canonical";

test("canonicalPegOut commits source chain (domain separation)", () => {
  const base = { sourceId: "sig", height: 1, from: "x", amountMilliViz: 10n, homeDestination: "viz-user" };
  const a = canonicalPegOut({ ...base, chain: "SOLANA" });
  const b = canonicalPegOut({ ...base, chain: "GRAM" });
  assert.equal(a.remoteChain, "SOLANA");
  assert.equal(b.remoteChain, "GRAM");
  assert.notEqual(a.digest, b.digest, "chain must be committed in digest (domain separation)");
});

test("same burn produces same digest (determinism)", () => {
  const burn = { chain: "SOLANA" as const, sourceId: "sig", height: 1, from: "x", amountMilliViz: 10n, homeDestination: "viz-user" };
  assert.equal(canonicalPegOut(burn).digest, canonicalPegOut(burn).digest);
});
