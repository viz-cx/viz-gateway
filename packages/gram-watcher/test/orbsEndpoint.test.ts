import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGramEndpoints } from "../src/orbsEndpoint";

const BASE = ["https://toncenter.com/api/v2/jsonRPC"];
const ORBS = "https://ton.access.orbs.network/abc/1/mainnet/toncenter-api-v2/jsonRPC";

test("enableOrbs=false is a pure pass-through and makes no resolve call", async () => {
  let resolved = false;
  const out = await resolveGramEndpoints(BASE, false, {
    resolve: async () => {
      resolved = true;
      return ORBS;
    },
    verify: async () => {},
  });
  assert.deepEqual(out, BASE);
  assert.equal(resolved, false, "resolver must not run when disabled");
});

test("resolved + verified Orbs endpoint is appended as a fallback", async () => {
  const out = await resolveGramEndpoints(BASE, true, {
    resolve: async () => ORBS,
    verify: async () => {},
  });
  assert.deepEqual(out, [...BASE, ORBS]);
});

test("fail-soft: a resolver error keeps the configured list unchanged", async () => {
  const out = await resolveGramEndpoints(BASE, true, {
    resolve: async () => {
      throw new Error("orbs down");
    },
    verify: async () => {},
  });
  assert.deepEqual(out, BASE);
});

test("fail-soft: a dead endpoint (verify throws) is NOT appended", async () => {
  const out = await resolveGramEndpoints(BASE, true, {
    resolve: async () => ORBS,
    verify: async () => {
      throw new Error("getMasterchainInfo failed");
    },
  });
  assert.deepEqual(out, BASE);
});

test("an already-present endpoint is not duplicated (and is not re-verified)", async () => {
  let verified = false;
  const out = await resolveGramEndpoints([...BASE, ORBS], true, {
    resolve: async () => ORBS,
    verify: async () => {
      verified = true;
    },
  });
  assert.deepEqual(out, [...BASE, ORBS]);
  assert.equal(verified, false, "no need to verify an endpoint already in the list");
});

test("an empty resolved URL is ignored", async () => {
  const out = await resolveGramEndpoints(BASE, true, {
    resolve: async () => "   ",
    verify: async () => {},
  });
  assert.deepEqual(out, BASE);
});
