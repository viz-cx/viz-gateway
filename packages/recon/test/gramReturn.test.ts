import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

test("auto-return: post-return state — locked >= circulating, recon passes (no pause)", async () => {
  const store = new InMemoryGatewayStore();

  // Scenario: user burned gross=20000 mVIZ for peg-out with invalid dest
  // GRAM.gate holds locked=100000 mVIZ (100 VIZ)
  // refundFeeMilliViz=5000 mVIZ
  // net returned to user = gross - fee = 20000 - 5000 = 15000 mVIZ
  //
  // Before return:
  //   totalSupply = 100000 mVIZ
  //   gatewayHeld = 20000 mVIZ (user's deposit)
  //   circulating = totalSupply - gatewayHeld = 80000 mVIZ
  //
  // After return (transfer net=15000 back to user):
  //   totalSupply = 100000 mVIZ (unchanged)
  //   gatewayHeld = 20000 - 15000 = 5000 mVIZ (fee retained)
  //   circulating = totalSupply - gatewayHeld = 95000 mVIZ
  //
  // Recon check:
  //   locked = 100000 mVIZ (VIZ at gram.gate, unchanged)
  //   circulating = 95000 mVIZ (the supply function input)
  //   unsweptFees = 0 mVIZ (no fee rows in store for this test)
  //   drift = locked - (circulating + unsweptFees) = 100000 - 95000 = 5000
  //   expected: drift >= 0 → OK (no under-backing)

  const locked = 100000n;
  const circulatingAfterReturn = 95000n;
  const unsweptFees = 0n;

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => circulatingAfterReturn }],
    async () => locked,
    store,
    cfg,
    "GRAM",
  );

  const result = await gram.check();
  assert.equal(result, true, "recon should pass after return (drift=5000 >= 0)");
  assert.equal(await store.isPaused(), false, "gateway must not be paused");
});

test("auto-return: retained fee stays in gatewayHeld, reducing circulating — recon surplus OK", async () => {
  const store = new InMemoryGatewayStore();

  // Scenario: user burned gross=10000 mVIZ for peg-out with invalid dest
  // GRAM.gate holds locked=50000 mVIZ (50 VIZ)
  // refundFeeMilliViz=2000 mVIZ
  // net returned to user = gross - fee = 10000 - 2000 = 8000 mVIZ
  //
  // Before return:
  //   totalSupply = 50000 mVIZ
  //   gatewayHeld = 10000 mVIZ (user's deposit)
  //   circulating = totalSupply - gatewayHeld = 40000 mVIZ
  //
  // After return (transfer net=8000 back to user):
  //   totalSupply = 50000 mVIZ (unchanged, wVIZ never burned)
  //   gatewayHeld = 10000 - 8000 = 2000 mVIZ (fee stays here)
  //   circulating = totalSupply - gatewayHeld = 48000 mVIZ
  //
  // The fee (2000 mVIZ) reduces circulating by exactly that amount; no backing shortfall.
  //
  // Recon check:
  //   locked = 50000 mVIZ (VIZ backing at gram.gate, unchanged)
  //   circulating = 48000 mVIZ
  //   unsweptFees = 0 mVIZ
  //   drift = 50000 - (48000 + 0) = 2000 mVIZ
  //   expected: drift >= 0 → OK (the surplus reflects the fee now in gatewayHeld)

  const locked = 50000n;
  const circulatingAfterReturn = 48000n; // totalSupply(50k) - gatewayHeld(2k)
  const unsweptFees = 0n;

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => circulatingAfterReturn }],
    async () => locked,
    store,
    cfg,
    "GRAM",
  );

  const result = await gram.check();
  assert.equal(result, true, "recon should pass (locked surplus accounts for retained fee)");
  assert.equal(await store.isPaused(), false, "gateway must not be paused");
});
