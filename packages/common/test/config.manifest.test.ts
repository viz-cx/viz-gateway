import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../src/config";

test("parseManifest reads gas constants, clamp bounds, and refund fee", () => {
  const m = parseManifest({
    n: 3, threshold: 2,
    operators: [{ id: "op-1" }, { id: "op-2" }, { id: "op-3" }],
    fees: {
      floorMilliViz: 10000, bps: 20,
      activationSurchargeMilliViz: { SOLANA: 10000, GRAM: 150000 },
      mintGasFloorMilliViz: { SOLANA: 1000, GRAM: 1000 },
      mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
      minVizPerTon: 100, maxVizPerTon: 20000, refundFeeMilliViz: 5000,
    },
  });
  assert.equal(m.fees?.mintGasTon, 0.06);
  assert.equal(m.fees?.margin, 1.5);
  assert.equal(m.fees?.minVizPerTon, 100);
  assert.equal(m.fees?.maxVizPerTon, 20000);
  assert.equal(m.fees?.refundFeeMilliViz, 5000n);
});

test("parseManifest defaults new fields when a legacy manifest omits them", () => {
  const m = parseManifest({
    n: 1, threshold: 1, operators: [{ id: "op-1" }],
    fees: {
      floorMilliViz: 10000, bps: 20,
      activationSurchargeMilliViz: { SOLANA: 10000, GRAM: 10000 },
      mintGasFloorMilliViz: { SOLANA: 1000, GRAM: 1000 },
    },
  });
  // Legacy manifests must still parse: new fields fall back to safe defaults.
  assert.equal(m.fees?.mintGasTon, 0.06);
  assert.equal(m.fees?.margin, 1.5);
  assert.equal(m.fees?.refundFeeMilliViz, 5000n);
});
