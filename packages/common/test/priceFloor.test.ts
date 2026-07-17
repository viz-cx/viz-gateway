import { test } from "node:test";
import assert from "node:assert/strict";
import { median, clampVizPerTon, deriveFloorMilliViz, deriveGramFeePolicy, clampBand, sweepFeePolicyFor } from "../src/priceFloor";
import { baseFee } from "../src/fees";
import type { GatewayFeeConfig } from "../src/config";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10000n, bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 150000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
  minVizPerTon: 100, maxVizPerTon: 20000, refundFeeMilliViz: 5000n,
};

test("median: odd, even, single, unsorted", () => {
  assert.equal(median([2000]), 2000);
  assert.equal(median([1950, 2000, 2100]), 2000);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([2100, 1950, 2000]), 2000);
  assert.throws(() => median([]));
});

test("clampVizPerTon bounds the value", () => {
  assert.equal(clampVizPerTon(50, 100, 20000), 100);
  assert.equal(clampVizPerTon(999999, 100, 20000), 20000);
  assert.equal(clampVizPerTon(2000, 100, 20000), 2000);
});

test("deriveFloorMilliViz rounds up (never under-covers gas)", () => {
  // 0.06 * 2000 * 1.5 = 180 VIZ = 180000 mVIZ
  assert.equal(deriveFloorMilliViz(0.06, 2000, 1.5), 180000n);
  // 0.06 * 200 * 1.5 = 18 VIZ (VIZ at $0.01)
  assert.equal(deriveFloorMilliViz(0.06, 200, 1.5), 18000n);
  // fractional -> ceil (0.06*2000.5*1.5*1000 = 180045.0...2 in IEEE754 -> ceil = 180046)
  assert.equal(deriveFloorMilliViz(0.06, 2000.5, 1.5), 180046n);
});

test("deriveGramFeePolicy derives floor + activation from clamped vizPerTon", () => {
  const p = deriveGramFeePolicy(FEES, 2000);
  assert.equal(p.floorMilliViz, 180000n);       // 0.06*2000*1.5
  assert.equal(p.activationSurchargeMilliViz, 150000n); // 0.05*2000*1.5
  assert.equal(p.bps, 20);
  assert.equal(p.mintGasFloorMilliViz, 1000n);
});

test("deriveGramFeePolicy clamps an out-of-band quote before deriving", () => {
  const p = deriveGramFeePolicy(FEES, 999999); // clamps to 20000
  assert.equal(p.floorMilliViz, deriveFloorMilliViz(0.06, 20000, 1.5));
});

test("clampBand returns the base-fee band from the vizPerTon clamp", () => {
  const { feeLo, feeHi } = clampBand(FEES);
  assert.equal(feeLo, deriveFloorMilliViz(0.06, 100, 1.5));   // 9000
  assert.equal(feeHi, deriveFloorMilliViz(0.06, 20000, 1.5)); // 1,800,000
});

test("sweepFeePolicyFor: GRAM floor is clampBand.feeLo, not the static manifest floor", () => {
  const p = sweepFeePolicyFor(FEES, "GRAM");
  assert.equal(p.floorMilliViz, clampBand(FEES).feeLo); // 9000, not 10000
  assert.notEqual(p.floorMilliViz, FEES.floorMilliViz); // differs from static floor
  assert.equal(p.bps, FEES.bps);
});

test("sweepFeePolicyFor: SOLANA keeps the static manifest floor unchanged", () => {
  const p = sweepFeePolicyFor(FEES, "SOLANA");
  assert.equal(p.floorMilliViz, FEES.floorMilliViz); // static floor preserved
});

test("sweepFeePolicyFor: floor-dominated GRAM peg-in uses feeLo, not static", () => {
  // GROSS small enough that bps% < feeLo → floor dominates
  const GROSS = 1_000_000n; // 1_000_000 * 20 / 10000 = 2000 < feeLo(9000) and < static(10000)
  const sweepBase = baseFee(GROSS, sweepFeePolicyFor(FEES, "GRAM"));
  const staticBase = baseFee(GROSS, { floorMilliViz: FEES.floorMilliViz, bps: FEES.bps, activationSurchargeMilliViz: 0n, mintGasFloorMilliViz: 1000n });
  assert.equal(sweepBase, clampBand(FEES).feeLo); // 9000 — never over-pulls
  assert.equal(staticBase, FEES.floorMilliViz);   // 10000 — old behaviour
  assert.ok(sweepBase < staticBase, "sweep base must be <= static to prevent over-pull");
});

test("sweepFeePolicyFor: bps-dominated GRAM peg-in gives same result as static (no under-pull)", () => {
  // GROSS large enough that bps% > both feeLo and static floor
  const GROSS = 10_000_000_000n; // 10_000_000_000 * 20 / 10000 = 20_000_000 >> 10000
  const sweepBase = baseFee(GROSS, sweepFeePolicyFor(FEES, "GRAM"));
  const staticBase = baseFee(GROSS, { floorMilliViz: FEES.floorMilliViz, bps: FEES.bps, activationSurchargeMilliViz: 0n, mintGasFloorMilliViz: 1000n });
  assert.equal(sweepBase, staticBase, "bps-dominated: floor is irrelevant, both give same base");
});
