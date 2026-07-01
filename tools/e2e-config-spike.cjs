"use strict";
const assert = require("node:assert");
const { loadE2eConfig, buildRunEnv } = require("../tools/e2e/dist/config.js");

// 1) missing required var throws naming the var
assert.throws(
  () => loadE2eConfig({}, "ton"),
  /missing required E2E var: E2E_VIZ_NODE_URL/,
);

// 2) full env parses
const env = {
  E2E_VIZ_NODE_URL: "https://node.viz.cx",
  E2E_VIZ_TEST_WIF: "5JtestWIF",
  E2E_VIZ_TEST_ACCOUNT: "e2e.test",
  E2E_VIZ_GATEWAY_ACCOUNT: "viz-gateway",
  E2E_VIZ_GATEWAY_WIF: "5JgatewayWIF",
  E2E_VIZ_RECIPIENT: "e2e.recv",
  E2E_VIZ_MIN_BALANCE_MILLI_VIZ: "5000000",
  E2E_TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC",
  E2E_TON_API_KEY: "k",
  E2E_TON_GATEWAY_JETTON_WALLET: "EQgw",
  E2E_TON_GATEWAY_OWNER: "EQowner",
  E2E_TON_JETTON_MINTER_ADDRESS: "EQmint",
  E2E_TON_MULTISIG_ADDRESS: "EQmultisig",
  E2E_TON_SIGNER_MNEMONIC: "word1 word2 word3",
  E2E_TON_BURN_MNEMONIC: "word1 word2",
  E2E_TON_BURN_OWNER: "EQburn",
  E2E_TON_MIN_GAS_NANO: "100000000",
};
const cfg = loadE2eConfig(env, "ton");
assert.equal(cfg.chain, "ton");
assert.equal(cfg.viz.testAccount, "e2e.test");
assert.equal(cfg.viz.minBalanceMilliViz, 5000000n);
assert.ok(/^e2e-\d+-[a-z0-9]+$/.test(cfg.runId), "runId shape");

// 3) buildRunEnv maps to service-facing names + persistent store by default
const runEnv = buildRunEnv(cfg);
assert.equal(runEnv.VIZ_NODE_URL, "https://node.viz.cx");
assert.equal(runEnv.TON_ENDPOINT, env.E2E_TON_ENDPOINT);
assert.equal(runEnv.FEDERATION_N, "1");
assert.equal(runEnv.FEDERATION_THRESHOLD, "1");
assert.equal(cfg.freshStore, false, "persistent store is the default");
assert.equal(runEnv.STORE_URL, "sqlite:./data/e2e.sqlite", "stable store path so idempotency survives runs");
assert.equal(runEnv.TON_MULTISIG_ADDRESS, "EQmultisig");
assert.equal(runEnv.TON_SIGNER_MNEMONIC, "word1 word2 word3");

// 3b) E2E_FRESH_STORE=1 opts back into a per-run store (clean idempotency slate)
const freshCfg = loadE2eConfig({ ...env, E2E_FRESH_STORE: "1" }, "ton");
assert.equal(freshCfg.freshStore, true, "E2E_FRESH_STORE=1 sets the flag");
assert.match(
  buildRunEnv(freshCfg).STORE_URL,
  new RegExp(`sqlite:\\./data/e2e-.*\\.sqlite$`),
  "fresh store is keyed by runId",
);

console.log("e2e-config-spike OK");

// --- amounts + deltas --------------------------------------------------------
const { uniqueGrossMilliViz, expectedNetMilliViz } = require("../tools/e2e/dist/amounts.js");
const { assertDelta } = require("../tools/e2e/dist/deltas.js");

// unique amount: same base, different runId → different gross, within base+[0,999]
const a = uniqueGrossMilliViz(20000n, "e2e-1-aaaaaa");
const b = uniqueGrossMilliViz(20000n, "e2e-1-bbbbbb");
assert.ok(a >= 20000n && a < 21000n, "gross within jitter band");
assert.notEqual(a, b, "different runIds give different gross");
assert.equal(uniqueGrossMilliViz(20000n, "e2e-1-aaaaaa"), a, "deterministic per runId");

// delta assertion
assert.doesNotThrow(() => assertDelta("viz", 100n, 130n, 30n));
assert.throws(() => assertDelta("viz", 100n, 125n, 30n), /viz/);

console.log("e2e-amounts-spike OK");

// --- poll --------------------------------------------------------------------
(async () => {
  const { pollUntil } = require("../tools/e2e/dist/poll.js");
  let n = 0;
  const got = await pollUntil(async () => (++n >= 3 ? "ready" : null), {
    timeoutMs: 1000, intervalMs: 10, label: "test",
  });
  assert.equal(got, "ready");
  await assert.rejects(
    pollUntil(async () => null, { timeoutMs: 50, intervalMs: 10, label: "never" }),
    /\[never\] timed out/,
  );
  console.log("e2e-poll-spike OK");
})();
