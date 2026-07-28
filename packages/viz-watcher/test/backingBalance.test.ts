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

test("null/undefined getAccounts result also throws (not just [])", async () => {
  const chain = new VizJsChain("https://node.example", accounts);
  for (const bad of [null, undefined]) {
    await withGetAccounts(
      (_names, cb) => cb(null, bad),
      async () => {
        await assert.rejects(
          () => chain.gatewayBalanceMilliViz("gram.gate"),
          /gram\.gate.*not found|empty getAccounts/i,
        );
      },
    );
  }
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

// A genuine on-chain zero (account exists, balance "0.000 VIZ") is NOT the empty-read case —
// it must pass through as 0n so a real drained backing account is still caught by recon.
test("present account with a real 0.000 VIZ balance returns 0n (not a throw)", async () => {
  const chain = new VizJsChain("https://node.example", accounts);
  await withGetAccounts(
    (_names, cb) => cb(null, [{ name: "gram.gate", balance: "0.000 VIZ" }]),
    async () => {
      assert.equal(await chain.gatewayBalanceMilliViz("gram.gate"), 0n);
    },
  );
});

// Sibling read on the SAME empty getAccounts shape: accountExists deliberately treats "empty" as
// "does not exist" (→ false), which is its fail-closed contract for peg-out lookups. Lock that the
// backing-balance fix did NOT change this different-by-design handling.
test("accountExists keeps its empty->false contract (fail-closed, unchanged)", async () => {
  const chain = new VizJsChain("https://node.example", accounts);
  await withGetAccounts(
    (_names, cb) => cb(null, []),
    async () => {
      assert.equal(await chain.accountExists("nope.acct"), false);
    },
  );
  await withGetAccounts(
    (_names, cb) => cb(null, [{ name: "gram.gate", balance: "1.000 VIZ" }]),
    async () => {
      assert.equal(await chain.accountExists("gram.gate"), true);
    },
  );
});
