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
  E2E_VIZ_RECIPIENT: "e2e.recv",
  E2E_VIZ_MIN_BALANCE_MILLI_VIZ: "5000000",
  E2E_TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC",
  E2E_TON_API_KEY: "k",
  E2E_TON_GATEWAY_JETTON_WALLET: "EQgw",
  E2E_TON_GATEWAY_OWNER: "EQowner",
  E2E_TON_JETTON_MINTER_ADDRESS: "EQmint",
  E2E_TON_BURN_MNEMONIC: "word1 word2",
  E2E_TON_BURN_OWNER: "EQburn",
  E2E_TON_MIN_GAS_NANO: "100000000",
};
const cfg = loadE2eConfig(env, "ton");
assert.equal(cfg.chain, "ton");
assert.equal(cfg.viz.testAccount, "e2e.test");
assert.equal(cfg.viz.minBalanceMilliViz, 5000000n);
assert.ok(/^e2e-\d+-[a-z0-9]+$/.test(cfg.runId), "runId shape");

// 3) buildRunEnv maps to service-facing names + fresh per-run store
const runEnv = buildRunEnv(cfg);
assert.equal(runEnv.VIZ_NODE_URL, "https://node.viz.cx");
assert.equal(runEnv.TON_ENDPOINT, env.E2E_TON_ENDPOINT);
assert.equal(runEnv.FEDERATION_N, "1");
assert.equal(runEnv.FEDERATION_THRESHOLD, "1");
assert.match(runEnv.STORE_URL, new RegExp(`sqlite:\\./data/e2e-.*\\.sqlite$`));

console.log("e2e-config-spike OK");
