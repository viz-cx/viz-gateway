import { test } from "node:test";
import assert from "node:assert/strict";
import { corsHeadersFor, serializeFees } from "../src/http";
import type { GatewayFeeConfig } from "@gateway/common";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { GRAM: 10000n, SOLANA: 10000n },
  mintGasFloorMilliViz: { GRAM: 1000n, SOLANA: 1000n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.1,
  minVizPerTon: 1,
  maxVizPerTon: 100000,
  refundFeeMilliViz: 5000n,
};

test("corsHeadersFor echoes a listed origin with Vary", () => {
  const h = corsHeadersFor("https://viz-cx.github.io", ["https://viz-cx.github.io"]);
  assert.equal(h["access-control-allow-origin"], "https://viz-cx.github.io");
  assert.equal(h["vary"], "Origin");
});

test("corsHeadersFor returns no header for an unlisted origin", () => {
  assert.deepEqual(corsHeadersFor("https://evil.example", ["https://gateway.viz.cx"]), {});
});

test("corsHeadersFor returns no header when Origin is absent", () => {
  assert.deepEqual(corsHeadersFor(undefined, ["https://gateway.viz.cx"]), {});
});

test("serializeFees emits only whitelisted fields as numbers", () => {
  const out = serializeFees(FEES);
  assert.deepEqual(out, {
    floorMilliViz: 10000,
    bps: 20,
    activationSurchargeMilliViz: { GRAM: 10000, SOLANA: 10000 },
    mintGasFloorMilliViz: { GRAM: 1000, SOLANA: 1000 },
    refundFeeMilliViz: 5000,
    decimals: 3,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "margin"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "minVizPerTon"), false);
});
