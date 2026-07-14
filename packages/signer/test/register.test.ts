import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "viz-js-lib/lib/auth/ecc";
import { recoverChallengeSigner } from "@gateway/viz-watcher/dist/challenge";
import { registerOnce } from "../src/register";

const pk = PrivateKey.fromSeed("op-1-register-seed");
const wif = pk.toWif();
const pub = pk.toPublicKey().toString();

test("registerOnce fetches a challenge then posts a valid signed registration", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).includes("/register/challenge")) {
      return new Response(JSON.stringify({ nonce: "n-123" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, expiresAt: 1 }), { status: 200 });
  }) as unknown as typeof fetch;

  await registerOnce({
    coordinatorUrl: "http://coord:8080/",
    operatorId: "op-1",
    advertiseUrl: "http://op-1:8090",
    wif,
    heartbeatMs: 20000,
    fetchImpl: fakeFetch,
  });

  assert.match(calls[0]!.url, /\/register\/challenge\?operator=op-1$/);
  const posted = JSON.parse(calls[1]!.body!) as { operator: string; url: string; nonce: string; sig: string };
  assert.equal(posted.operator, "op-1");
  assert.equal(posted.nonce, "n-123");
  // The posted signature must recover to this operator's key over the advertised url.
  assert.equal(recoverChallengeSigner("op-1", "http://op-1:8090", "n-123", posted.sig), pub);
});

test("registerOnce throws when the coordinator rejects the registration", async () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes("/register/challenge")) {
      return new Response(JSON.stringify({ nonce: "n-1" }), { status: 200 });
    }
    return new Response("nope", { status: 400 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    registerOnce({
      coordinatorUrl: "http://coord:8080",
      operatorId: "op-1",
      advertiseUrl: "http://op-1:8090",
      wif,
      heartbeatMs: 20000,
      fetchImpl: fakeFetch,
    }),
    /register HTTP 400/,
  );
});
