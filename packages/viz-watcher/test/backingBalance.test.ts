import { test } from "node:test";
import assert from "node:assert/strict";
import viz from "viz-js-lib";
import { GatewayAccounts } from "@gateway/common";
import { VizJsChain } from "../src/vizChain";

// gatewayBalanceMilliViz feeds recon's backing invariant. A backing account ALWAYS exists
// on-chain, so an empty getAccounts result is an anomalous/partial node read — never a real
// zero balance. It MUST throw (→ recon indeterminate → no pause), not return 0n (→ phantom
// under-backing → false-pause, the 2026-07-28 incident). Lock both directions here.

const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });

function withGetAccounts<T>(stub: (names: string[], cb: (err: unknown, res: unknown) => void) => void, fn: () => Promise<T>): Promise<T> {
  const orig = viz.api.getAccounts;
  viz.api.getAccounts = stub as typeof viz.api.getAccounts;
  return fn().finally(() => {
    viz.api.getAccounts = orig;
  });
}

test("empty getAccounts throws (indeterminate) — never a phantom 0 balance", async () => {
  const chain = new VizJsChain("https://node.example", accounts);
  await withGetAccounts(
    (_names, cb) => cb(null, []),
    async () => {
      await assert.rejects(
        () => chain.gatewayBalanceMilliViz("gram.gate"),
        /gram\.gate.*not found|empty getAccounts/i,
      );
    },
  );
});

test("present account returns its balance in mVIZ", async () => {
  const chain = new VizJsChain("https://node.example", accounts);
  await withGetAccounts(
    (_names, cb) => cb(null, [{ name: "gram.gate", balance: "43587.408 VIZ" }]),
    async () => {
      assert.equal(await chain.gatewayBalanceMilliViz("gram.gate"), 43587408n);
    },
  );
});
