import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFloorMilliViz, pegInFeePolicyFor, type GatewayFeeConfig } from "../src";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10_000n,
  gramFloorMilliViz: 45_000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 37_500n },
  mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.5,
  gramVizPerTon: 500,
  refundFeeMilliViz: 5_000n,
};

test("deriveFloorMilliViz = ceil(gasTon * vizPerTon * margin * 1000)", () => {
  assert.equal(deriveFloorMilliViz(0.06, 500, 1.5), 45_000n);
  assert.equal(deriveFloorMilliViz(0.05, 500, 1.5), 37_500n);
});

test("pegInFeePolicyFor uses the derived GRAM floor, static Solana floor", () => {
  assert.equal(pegInFeePolicyFor(FEES, "GRAM").floorMilliViz, 45_000n);
  assert.equal(pegInFeePolicyFor(FEES, "GRAM").activationSurchargeMilliViz, 37_500n);
  assert.equal(pegInFeePolicyFor(FEES, "SOLANA").floorMilliViz, 10_000n);
});

test("pegInFeePolicyFor falls back to floorMilliViz when gramFloorMilliViz is unset", () => {
  const legacy = { ...FEES, gramFloorMilliViz: undefined };
  assert.equal(pegInFeePolicyFor(legacy, "GRAM").floorMilliViz, 10_000n);
});
