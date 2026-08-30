import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverChallengeSigner } from "@gateway/viz-watcher/dist/challenge";
import { registerOnce, startRegisterLoop, type RegisterDeps } from "../src/register";

// Pinned throwaway test key (PrivateKey.fromSeed("viz-gateway-test-register-loop")).
const WIF = "5KbCuVwda9nKtLrZ6QgG6aQhvm3UNiPqaSabWtFaXHxa3APJ4TQ";
const PUB = "VIZ6bA3EYLcYUW4MqBnuStZr9mtifbsPu2sB8uEZmXFxzVdWZzyLa";

interface Call {
  url: string;
  body?: unknown;
}

/**
 * Fake coordinator. `plan` is consumed one entry per REGISTER post; "ok" accepts,
 * anything else is returned as an HTTP failure. Challenge requests always succeed
 * unless challengeStatus says otherwise.
 */
function fakeCoordinator(plan: string[], challengeStatus = 200) {
  const calls: Call[] = [];
  let posts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/register/challenge")) {
      return {
        ok: challengeStatus === 200,
        status: challengeStatus,
        json: async () => ({ nonce: `nonce-${calls.length}` }),
        text: async () => "",
      };
    }
    const verdict = plan[Math.min(posts++, plan.length - 1)];
    return {
      ok: verdict === "ok",
      status: verdict === "ok" ? 200 : 503,
      json: async () => ({}),
      text: async () => (verdict === "ok" ? "" : verdict),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, postCount: () => posts };
}

function deps(fetchImpl: typeof fetch, over: Partial<RegisterDeps> = {}): RegisterDeps {
  return {
    coordinatorUrl: "http://coordinator:8080/",
    operatorId: "op-1",
    advertiseUrl: "http://op-1:8090",
    wif: WIF,
    heartbeatMs: 20,
    fetchImpl,
    ...over,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `cond` holds. Asserting on the OUTCOME rather than on elapsed time keeps
 * this stable: each tick does a real secp256k1 sign, so heartbeat wall-clock is not
 * predictable enough to count ticks by sleeping.
 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

test("registerOnce posts a signature that recovers to the operator's own key", async () => {
  const c = fakeCoordinator(["ok"]);
  await registerOnce(deps(c.fetchImpl));

  // Trailing slash on coordinatorUrl must not produce a double slash.
  assert.equal(c.calls[0].url, "http://coordinator:8080/register/challenge?operator=op-1");
  assert.equal(c.calls[1].url, "http://coordinator:8080/register");

  const body = c.calls[1].body as { operator: string; url: string; nonce: string; sig: string };
  assert.equal(body.operator, "op-1");
  assert.equal(body.nonce, "nonce-1", "must sign the nonce the coordinator just issued");
  assert.equal(recoverChallengeSigner(body.operator, body.url, body.nonce, body.sig), PUB);
});

test("registerOnce throws when the challenge request fails", async () => {
  const c = fakeCoordinator(["ok"], 500);
  await assert.rejects(() => registerOnce(deps(c.fetchImpl)), /challenge HTTP 500/);
  assert.equal(c.postCount(), 0, "must not register without a fresh nonce");
});

test("registerOnce surfaces the coordinator's rejection detail", async () => {
  const c = fakeCoordinator(["not in operator set"]);
  await assert.rejects(() => registerOnce(deps(c.fetchImpl)), /register HTTP 503: not in operator set/);
});

test("startRegisterLoop keeps re-registering to hold the lease", async () => {
  const c = fakeCoordinator(["ok"]);
  const stop = startRegisterLoop(deps(c.fetchImpl));
  try {
    await waitFor(() => c.postCount() >= 3, "three successful heartbeats");
  } finally {
    stop();
  }
});

// The signer dropping out of the federation permanently would stall the 2-of-3.
test("startRegisterLoop recovers after a failed registration", async () => {
  const c = fakeCoordinator(["down", "down", "ok"]);
  const stop = startRegisterLoop(deps(c.fetchImpl));
  try {
    await waitFor(() => c.postCount() >= 3, "retries past two failures");
    // Every nonce is freshly issued: the loop re-challenges instead of reusing a stale one.
    const nonces = c.calls.filter((x) => x.body).map((x) => (x.body as { nonce: string }).nonce);
    assert.equal(new Set(nonces).size, nonces.length, "each attempt must sign a fresh nonce");
  } finally {
    stop();
  }
});

test("stop() halts the loop and no further calls land", async () => {
  const c = fakeCoordinator(["ok"]);
  const stop = startRegisterLoop(deps(c.fetchImpl));
  await waitFor(() => c.postCount() >= 1, "the loop to start");
  stop();
  const settled = c.postCount();
  await sleep(120);
  assert.equal(c.postCount(), settled, "no registrations may land after stop()");
});
