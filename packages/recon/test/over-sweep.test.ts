import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import type { PegInFeePolicy } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// Regression for the false over-sweep pause (prod, 2026-07-17): the dispatcher sizes the sweep
// and the signer validates it with the STATIC manifest floor, but recon's GRAM path derived the
// base with the dynamic clamp-band floor `feeLo` (the band MINIMUM). Any real fee above feeLo then
// read as over-swept (swept static-base 10000 vs derived feeLo-base 9000 → −1000/peg-in), tripping
// the M10 guard and pausing the whole gateway. recon must derive with the SAME floor that was
// actually withheld+swept.
const GROSS = 1_000_000n; // pct = GROSS*20/10000 = 2000 < floor, so base == floor
const STATIC_FLOOR = 10_000n; // manifest floor the dispatcher + signer use to size/validate the sweep
const FEE_LO = 9_000n; // clamp-band lower bound the buggy recon used (deriveFloorMilliViz(0.06,100,1.5))

function policy(floorMilliViz: bigint): PegInFeePolicy {
  return {
    floorMilliViz,
    bps: 20,
    activationSurchargeMilliViz: 0n,
    mintGasFloorMilliViz: 1_000n,
  };
}

async function seedGramPegInAndSweep(store: InMemoryGatewayStore): Promise<void> {
  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: GROSS, digest: "d1" });
  await store.setStatus("gram-1", "CONFIRMED");
  await store.setFee("gram-1", STATIC_FLOOR);
  // The sweep is the static-floor base — exactly what the dispatcher enqueues and the signer signs.
  await store.enqueue({ id: "gram-1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: STATIC_FLOOR, digest: "d2" });
  await store.setStatus("gram-1:fee", "CONFIRMED");
}

test("over-sweep guard: static-floor sweep does NOT false-trip when recon derives with the same floor", async () => {
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store);

  // derived base = baseFee(GROSS, floor 10000) = 10000; swept = 10000 → unsweptFees = 0.
  // circulating = 0, locked = 0 → drift = 0 → OK, never paused.
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(STATIC_FLOOR),
  );

  assert.equal(await gram.check(), true, "sweep sized at the withheld base must reconcile clean");
  assert.equal(await store.isPaused(), false, "gateway must NOT pause on a legitimately-swept fee");
});

test("over-sweep guard: reproduces the false positive when recon derives with the band floor feeLo (the bug)", async () => {
  const store = new InMemoryGatewayStore();
  await seedGramPegInAndSweep(store);

  // derived base = baseFee(GROSS, floor 9000) = 9000; swept = 10000 → unsweptFees = −1000 → guard trips.
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store,
    cfg,
    "GRAM",
    policy(FEE_LO),
  );

  assert.equal(await gram.check(), false, "the feeLo-floored policy is what produced the bogus over-sweep");
  assert.ok(await store.isPaused(), "documents the pre-fix behaviour: gateway false-paused");
});
