import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFee, pegInFeePolicyFor, type GatewayFeeConfig } from "@gateway/common";

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

// The signer accepts exactly gross − base − activation; anything else is rejected.
test("GRAM exact-match net: provisioned dest withholds only base", () => {
  const gross = 1_000_000n;
  const base = baseFee(gross, pegInFeePolicyFor(FEES, "GRAM"));
  assert.equal(base, 45_000n); // floor dominates at this gross
  assert.equal(gross - base, 955_000n);
});

test("GRAM exact-match net: unprovisioned dest withholds base + activation", () => {
  const gross = 1_000_000n;
  const base = baseFee(gross, pegInFeePolicyFor(FEES, "GRAM"));
  assert.equal(gross - base - 37_500n, 917_500n);
});
