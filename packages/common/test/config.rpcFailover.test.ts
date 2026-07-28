import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

// Isolate each case from env pollution: RPC failover reads VIZ_NODE_URL / VIZ_NODE_WS /
// GRAM_ENDPOINT / GRAM_ORBS_FALLBACK. Save+restore so the shared node:test process (all
// suites in one run) can't leak a list from one case into another.
// FEDERATION_MANIFEST is isolated too: the repo's ./federation.json now pins rpc.* defaults, so
// these "env default" cases must NOT read it (the manifest 3-node list / orbs=true would leak in).
// Default to a nonexistent path (→ count-only synthesized federation, no rpc) unless a case
// overrides it to exercise the manifest layer explicitly. Manifest precedence is covered in
// config.manifestDefaults.test.ts.
const KEYS = ["VIZ_NODE_URL", "VIZ_NODE_WS", "GRAM_ENDPOINT", "GRAM_ORBS_FALLBACK", "FEDERATION_MANIFEST"];
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  process.env.FEDERATION_MANIFEST = "./test-no-such-manifest.json";
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("VIZ_NODE_URL CSV -> nodeUrls list; scalar nodeUrl = first", () => {
  withEnv({ VIZ_NODE_URL: "https://a,https://b,https://c" }, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.viz.nodeUrls, ["https://a", "https://b", "https://c"]);
    assert.equal(cfg.viz.nodeUrl, "https://a");
  });
});

test("VIZ_NODE_URL trims whitespace and drops empties", () => {
  withEnv({ VIZ_NODE_URL: "  https://a ,  https://b  , " }, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["https://a", "https://b"]);
  });
});

test("VIZ_NODE_URL whitespace-separated also splits", () => {
  withEnv({ VIZ_NODE_URL: "https://a https://b" }, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["https://a", "https://b"]);
  });
});

test("VIZ_NODE_URL dedupes repeated nodes (order preserved)", () => {
  withEnv({ VIZ_NODE_URL: "https://a,https://a,https://b" }, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["https://a", "https://b"]);
  });
});

test("VIZ_NODE_URL single -> singleton list", () => {
  withEnv({ VIZ_NODE_URL: "https://only" }, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["https://only"]);
  });
});

test("VIZ node default when unset (keeps VIZ_NODE_WS fallback)", () => {
  withEnv({}, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["https://node.viz.cx"]);
  });
  withEnv({ VIZ_NODE_WS: "wss://legacy" }, () => {
    assert.deepEqual(loadConfig().viz.nodeUrls, ["wss://legacy"]);
  });
});

test("GRAM_ENDPOINT CSV -> endpoints list; scalar endpoint = first; default single", () => {
  withEnv({ GRAM_ENDPOINT: "https://toncenter/x, https://orbs/y" }, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.gram.endpoints, ["https://toncenter/x", "https://orbs/y"]);
    assert.equal(cfg.gram.endpoint, "https://toncenter/x");
  });
  withEnv({}, () => {
    assert.deepEqual(loadConfig().gram.endpoints, ["https://toncenter.com/api/v2/jsonRPC"]);
  });
});

test("GRAM_ORBS_FALLBACK defaults false; truthy strings enable it", () => {
  withEnv({}, () => assert.equal(loadConfig().gram.orbsFallback, false));
  for (const v of ["1", "true", "TRUE", "yes"]) {
    withEnv({ GRAM_ORBS_FALLBACK: v }, () => assert.equal(loadConfig().gram.orbsFallback, true, `"${v}" should enable`));
  }
  for (const v of ["0", "false", "no", ""]) {
    withEnv({ GRAM_ORBS_FALLBACK: v }, () => assert.equal(loadConfig().gram.orbsFallback, false, `"${v}" should stay off`));
  }
});
