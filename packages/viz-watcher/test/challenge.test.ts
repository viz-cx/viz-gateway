import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "viz-js-lib/lib/auth/ecc";
import { challengeMessage, signChallenge, recoverChallengeSigner, pubkeyFromWif } from "../src/challenge";

const pk = PrivateKey.fromSeed("viz-gateway-test-op-1");
const wif = pk.toWif();
const pub = pk.toPublicKey().toString();

test("recovered signer equals the signing key's pubkey", () => {
  const sig = signChallenge("op-1", "http://op-1:8090", "nonce-abc", wif);
  assert.equal(recoverChallengeSigner("op-1", "http://op-1:8090", "nonce-abc", sig), pub);
});

test("a tampered url does not recover to the same key", () => {
  const sig = signChallenge("op-1", "http://op-1:8090", "nonce-abc", wif);
  // Recovering over a different message yields some other key (never the signer's).
  assert.notEqual(recoverChallengeSigner("op-1", "http://evil:8090", "nonce-abc", sig), pub);
});

test("message binds domain, operator, url, nonce in order", () => {
  assert.equal(challengeMessage("op-2", "http://x", "n1"), "viz-gateway-register\nop-2\nhttp://x\nn1");
});

test("signing with an empty wif throws", () => {
  assert.throws(() => signChallenge("op-1", "http://x", "n", ""), /WIF/);
});

// --- vizPerTon quote binding ---

test("quote is bound into the signature (recovers the same key)", () => {
  const p = pubkeyFromWif(wif);
  const sig = signChallenge("op-1", "https://op1", "nonce123", wif, 2000);
  assert.equal(recoverChallengeSigner("op-1", "https://op1", "nonce123", sig, 2000), p);
});

test("a tampered quote fails to recover the signer key", () => {
  const p = pubkeyFromWif(wif);
  const sig = signChallenge("op-1", "https://op1", "nonce123", wif, 2000);
  // Verifying with a different quote recovers a DIFFERENT (wrong) key.
  assert.notEqual(recoverChallengeSigner("op-1", "https://op1", "nonce123", sig, 9999), p);
});

test("omitting the quote matches the legacy message (back-compat)", () => {
  const p = pubkeyFromWif(wif);
  const sig = signChallenge("op-1", "https://op1", "nonce123", wif); // no quote
  assert.equal(recoverChallengeSigner("op-1", "https://op1", "nonce123", sig), p);
});

test("message with quote appends vizPerTon on a new line", () => {
  assert.equal(challengeMessage("op-1", "http://x", "n1", 2000), "viz-gateway-register\nop-1\nhttp://x\nn1\n2000");
});
