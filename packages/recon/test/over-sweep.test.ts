import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import type { PegInFeePolicy } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// After fix/gram-sweep-floor-align-feelo: dispatcher, signer, and recon all use the band
// floor feeLo (9000) as the GRAM sweep base, not the static manifest floor (10000).
// feeLo ≤ dynamic mint floor always, so swept ≤ withheld — no over-pull is possible.
// Any surplus (dynamicFloor − feeLo) stays on gram.gate as over-backing (safe direction).
const GROSS = 1_000_000n; // pct = GROSS*20/10000 = 2000 < either floor, so base == floor
const STATIC_FLOOR = 10_000n; // manifest floor — no longer used on the sweep side for GRAM
const FEE_LO = 9_000n; // clampBand lower bound — the correct GRAM sweep floor after this fix

function policy(floorMilliViz: bigint): PegInFeePolicy {
  return {
    floorMilliViz,
    bps: 20,
    activationSurchargeMilliViz: 0n,
    mintGasFloorMilliViz: 1_000n,
  };
}

async function seedGramPegInAndSweep(store: InMemoryGatewayStore, sweptAmount: bigint): Promise<void> {
  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: "d1" });
  await store.setStatus("gram-1", "CONFIRMED");
  await store.setFee("gram-1", sweptAmount);
  await store.enqueue({ id: "gram-1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: sweptAmount, digest: "d2" });
  await store.setStatus("gram-1:fee", "CONFIRMED");
}

test("over-sweep guard: feeLo sweep reconciles clean when recon uses feeLo policy", async () => {
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store, FEE_LO); // sweep = 9000 (feeLo-base)

  // derived base = baseFee(GROSS, floor 9000) = 9000; swept = 9000 → unsweptFees = 0.
  // circulating = 0, locked = 0 → drift = 0 → OK, never paused.
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), true, "feeLo-base sweep must reconcile clean");
  assert.equal(await store.isPaused(), false, "gateway must NOT pause on a correctly-swept fee");
});

test("over-sweep guard: catches the latent bug — static-base sweep (10000) against feeLo-withheld mint (9000) reads as over-sweep", async () => {
  const store = new InMemoryGatewayStore();
  // Deposit where mint withheld 9000 (feeLo) but sweep erroneously pulled 10000 (static).
  // This is the scenario that was UNDETECTED before this fix (both sides used static → drift=0).
  // Now that recon uses feeLo policy, it derives base=9000 while swept=10000 → −1000 → guard trips.
  await seedGramPegInAndSweep(store, STATIC_FLOOR); // sweep = 10000 (old static-base)

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO), // recon now derives with feeLo — reveals the over-pull
  );

  assert.equal(await gram.check(), false, "static-sweep against feeLo-mint must be caught as over-sweep");
  assert.ok(await store.isPaused(), "gateway must pause when an over-sweep is detected");
});

// ---------------------------------------------------------------------------
// Production recovery scenario (2026-07-17): historical static-floor FEE_SWEEPs
// ---------------------------------------------------------------------------
// After deploying feeLo recon (sweepFeePolicyFor), the 3 existing static-floor
// FEE_SWEEPs (10000 each) triggered the over-sweep guard immediately on startup.
// The operational fix was to DB-correct those rows from 10000 → 9000. These tests
// document both the failure mode and the recovery so we don't re-derive this in prod.

test("over-sweep guard: deploy scenario — historical static FEE_SWEEPs trigger guard under feeLo policy", async () => {
  // Seed with the pre-correction state: FEE_SWEEP at STATIC_FLOOR (what was in prod DB).
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store, STATIC_FLOOR); // sweep=10000, feeLo-derived=9000

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), false, "static-sweep under feeLo policy pauses on startup");
  assert.ok(await store.isPaused(), "gateway is paused — DB correction required before unpause");
});

test("over-sweep guard: recovery scenario — DB-corrected FEE_SWEEP (9000) clears the over-sweep", async () => {
  // After DB correction: FEE_SWEEP amount changed from 10000 → 9000 in SQLite,
  // matching what feeLo policy now derives. Recon must reconcile clean.
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store, FEE_LO); // sweep=9000 (corrected)

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), true, "corrected records reconcile clean — safe to unpause");
  assert.equal(await store.isPaused(), false, "gateway stays unpaused after correction");
});

test("over-sweep guard: multiple corrected historical + new feeLo peg-ins all reconcile clean", async () => {
  const store = new InMemoryGatewayStore();

  // Simulate the production state after correction: 3 historical records fixed to 9000.
  for (let i = 0; i < 3; i++) {
    const id = `gram-hist-${i}`;
    await store.enqueue({ id, direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: `d${i}` });
    await store.setStatus(id, "CONFIRMED");
    await store.setFee(id, FEE_LO);
    await store.enqueue({ id: `${id}:fee`, direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: FEE_LO, digest: `d${i}f` });
    await store.setStatus(`${id}:fee`, "CONFIRMED");
  }

  // Plus a new peg-in also swept at feeLo (the new normal going forward).
  await store.enqueue({ id: "gram-new", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: "dnew" });
  await store.setStatus("gram-new", "CONFIRMED");
  await store.setFee("gram-new", FEE_LO);
  await store.enqueue({ id: "gram-new:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: FEE_LO, digest: "dnewf" });
  await store.setStatus("gram-new:fee", "CONFIRMED");

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), true, "mixed corrected-historical + new feeLo records all clean");
});

test("over-sweep guard: bps-dominated GRAM peg-in (floor irrelevant) — feeLo and static give same base", async () => {
  // GROSS large enough that bps% > both floors; the floor choice doesn't matter here.
  const LARGE_GROSS = 10_000_000_000n; // 10B mVIZ * 20 bps / 10000 = 20M >> 10000
  const BPS_BASE = LARGE_GROSS * 20n / 10_000n; // 20_000_000n

  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "gram-2", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: LARGE_GROSS, digest: "d3" });
  await store.setStatus("gram-2", "CONFIRMED");
  await store.setFee("gram-2", BPS_BASE);
  await store.enqueue({ id: "gram-2:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: BPS_BASE, digest: "d4" });
  await store.setStatus("gram-2:fee", "CONFIRMED");

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), true, "bps-dominated peg-in must reconcile clean regardless of floor choice");
});
