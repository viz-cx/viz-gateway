import { test } from "node:test";
import assert from "node:assert/strict";
import { clampBand } from "@gateway/common";
import { assertGramNetInBand } from "../src/keyedSigner";

const FEES = {
  floorMilliViz: 10000n, bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 150000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
  minVizPerTon: 100, maxVizPerTon: 20000, refundFeeMilliViz: 5000n,
} as const;

test("accepts a net whose fee is within the band (provisioned dest)", () => {
  const gross = 1_000_000n; // 1000 VIZ
  const net = gross - 180000n; // fee 180 VIZ, within [9000, 1_800_000]
  assert.doesNotThrow(() => assertGramNetInBand(gross, net, true, FEES));
});

test("rejects a net that under-charges below the band (coordinator griefing)", () => {
  const gross = 1_000_000n;
  const net = gross - 100n; // fee 100 mVIZ < feeLo 9000
  assert.throws(() => assertGramNetInBand(gross, net, true, FEES), /below/i);
});

test("rejects a net that over-charges above the band", () => {
  const { feeHi } = clampBand(FEES);
  const gross = 5_000_000n;
  const net = gross - (feeHi + 200000n); // fee above band even allowing activation
  assert.throws(() => assertGramNetInBand(gross, net, false, FEES), /above/i);
});

test("rejects net below the mint-gas floor", () => {
  const gross = 9500n; // just above feeLo, but net would be < mintGasFloor
  const net = 500n;
  assert.throws(() => assertGramNetInBand(gross, net, true, FEES), /mint-gas floor|net/i);
});
