import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// Recon now uses the pinned per-row fee (unsweptFeesMilliViz) for both chains.
// The floor values are static: GRAM=45000, SOLANA=10000.
const GROSS = 1_000_000n;
const GRAM_FEE = 45_000n; // static GRAM floor
const SOLANA_FEE = 10_000n;

async function seedGramPegInAndSweep(store: InMemoryGatewayStore, sweptAmount: bigint, pinnedFee?: bigint): Promise<void> {
  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: "d1" });
  await store.setStatus("gram-1", "CONFIRMED");
  await store.setFee("gram-1", pinnedFee ?? sweptAmount);
  await store.enqueue({ id: "gram-1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: sweptAmount, digest: "d2" });
  await store.setStatus("gram-1:fee", "CONFIRMED");
}

test("over-sweep guard: static GRAM sweep (45000) reconciles clean", async () => {
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store, GRAM_FEE); // pinned = swept = 45000

  // circulating = 0, locked = 0 → drift = 0 → OK
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    1_000n, // sanityFloor
  );

  assert.equal(await gram.check(), true, "correct static-floor sweep must reconcile clean");
  assert.equal(await store.isPaused(), false, "gateway must NOT pause on correctly-swept fee");
});

test("over-sweep guard: catches over-sweep — swept more than pinned fee", async () => {
  const store = new InMemoryGatewayStore();
  // pinned 45000 but swept 50000 → over-sweep
  await seedGramPegInAndSweep(store, 50_000n, 45_000n);

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    1_000n,
  );

  assert.equal(await gram.check(), false, "over-swept should trigger pause");
  assert.ok(await store.isPaused(), "gateway must pause when over-sweep is detected");
});

test("over-sweep guard: activation retained as unswept surplus reconciles clean", async () => {
  const store = new InMemoryGatewayStore();
  // gross 1M, pinned fee = base + activation = 45000 + 37500 = 82500; only base swept (45000)
  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: "d1" });
  await store.setStatus("gram-1", "CONFIRMED");
  await store.setFee("gram-1", 82_500n); // base + activation pinned
  await store.enqueue({ id: "gram-1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: 45_000n, digest: "d2" });
  await store.setStatus("gram-1:fee", "CONFIRMED");

  // circulating = gross - fee = 1_000_000 - 82_500 = 917_500
  // unswept = pinned(82500) - swept(45000) = 37_500 (activation surplus)
  // locked = circulating + unswept = 917_500 + 37_500 = 955_000
  // gatewayBalance = gross - swept = 1_000_000 - 45_000 = 955_000 ✓
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 917_500n }],
    async () => 955_000n,
    store,
    cfg,
    "GRAM",
    1_000n,
  );

  assert.equal(await gram.check(), true, "activation retained as surplus must reconcile clean");
  assert.equal(await store.isPaused(), false);
});

test("over-sweep guard: bps-dominated GRAM peg-in reconciles clean", async () => {
  const LARGE_GROSS = 10_000_000_000n;
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
    1_000n,
  );

  assert.equal(await gram.check(), true, "bps-dominated peg-in must reconcile clean");
});

test("over-sweep guard: multiple clean peg-ins all reconcile", async () => {
  const store = new InMemoryGatewayStore();

  for (let i = 0; i < 3; i++) {
    const id = `gram-hist-${i}`;
    await store.enqueue({ id, direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: `d${i}` });
    await store.setStatus(id, "CONFIRMED");
    await store.setFee(id, GRAM_FEE);
    await store.enqueue({ id: `${id}:fee`, direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: GRAM_FEE, digest: `d${i}f` });
    await store.setStatus(`${id}:fee`, "CONFIRMED");
  }

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    1_000n,
  );

  assert.equal(await gram.check(), true, "multiple corrected historical records all clean");
});

test("SOLANA: pinned fee sweep reconciles clean", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "sol-1", direction: "PEG_IN", remoteChain: "SOLANA", recipient: "user", amountMilliViz: GROSS, digest: "s1" });
  await store.setStatus("sol-1", "CONFIRMED");
  await store.setFee("sol-1", SOLANA_FEE);
  await store.enqueue({ id: "sol-1:fee", direction: "FEE_SWEEP", remoteChain: "SOLANA", recipient: "fees.gate", amountMilliViz: SOLANA_FEE, digest: "s2" });
  await store.setStatus("sol-1:fee", "CONFIRMED");

  const sol = new Recon(
    [{ name: "SOLANA", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "SOLANA",
    1_000n,
  );

  assert.equal(await sol.check(), true);
  assert.equal(await store.isPaused(), false);
});
