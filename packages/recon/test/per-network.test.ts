import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

test("per-chain recon: SOLANA surplus does not mask GRAM under-backing", async () => {
  const store = new InMemoryGatewayStore();

  // GRAM: locked 10, circulating 40 → under-backed → must pause
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 40n }],
    async () => 10n,
    store,
    cfg,
    "GRAM",
  );

  const r = await gram.check();
  assert.equal(r, false, "GRAM recon should detect under-backing");
  assert.ok(await store.isPaused(), "gateway must be paused on under-backing");
});

test("per-chain recon: GRAM and SOLANA each healthy individually", async () => {
  const store = new InMemoryGatewayStore();

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 10n }],
    async () => 20n,
    store,
    cfg,
    "GRAM",
  );

  const solana = new Recon(
    [{ name: "SOLANA", supply: async () => 5n }],
    async () => 30n,
    store,
    cfg,
    "SOLANA",
  );

  assert.equal(await gram.check(), true, "GRAM recon healthy");
  assert.equal(await solana.check(), true, "SOLANA recon healthy");
  assert.equal(await store.isPaused(), false, "no under-backing, not paused");
});

test("per-chain recon: unsweptFeesMilliViz filtered by chain", async () => {
  const store = new InMemoryGatewayStore();

  // Seed: SOLANA PEG_IN fee=5, GRAM PEG_IN fee=7, SOLANA FEE_SWEEP=5
  await store.enqueue({ id: "sol-1", direction: "PEG_IN", remoteChain: "SOLANA", recipient: "user", amountMilliViz: 100n, digest: "d1" });
  await store.setStatus("sol-1", "CONFIRMED");
  await store.setFee("sol-1", 5n);

  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user2", amountMilliViz: 200n, digest: "d2" });
  await store.setStatus("gram-1", "CONFIRMED");
  await store.setFee("gram-1", 7n);

  await store.enqueue({ id: "sol-1:fee", direction: "FEE_SWEEP", remoteChain: "SOLANA", recipient: "fees.gate", amountMilliViz: 5n, digest: "d3" });
  await store.setStatus("sol-1:fee", "CONFIRMED");

  // GRAM recon: locked=7 (exactly equal circulating + unswept) → OK
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 7n,
    store,
    cfg,
    "GRAM",
  );
  // locked=7, circulating=0, unsweptFees(GRAM)=7 → drift = 7-(0+7) = 0 → OK
  assert.equal(await gram.check(), true, "GRAM recon uses per-chain unsweptFees");

  // SOLANA recon: locked=0, circulating=0, unsweptFees(SOLANA)=0 → OK
  const solana = new Recon(
    [{ name: "SOLANA", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "SOLANA",
  );
  assert.equal(await solana.check(), true, "SOLANA recon uses per-chain unsweptFees");
});
