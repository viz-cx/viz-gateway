import { test } from "node:test";
import assert from "node:assert/strict";
import viz from "viz-js-lib";
import { PrivateKey } from "viz-js-lib/lib/auth/ecc";
import { resolveMemoDestination } from "../src/memo";

// Deterministic test keypairs (seed-derived; never real gate keys).
const wif = PrivateKey.fromSeed("viz-gateway memo test key A").toWif();
const pub = viz.auth.wifToPublic(wif);
const otherWif = PrivateKey.fromSeed("viz-gateway memo test key B").toWif();

// A plaintext TON destination (shape doesn't matter to the resolver — validation happens later).
const ADDR = "EQCfGcOZexampledestinationaddress0123456789abcdefgh";

/** Encrypt `plaintext` to `pub` as a wallet would (memo marked for encryption with a leading '#'). */
function encrypt(plaintext: string, toPub = pub, fromWif = wif): string {
  return viz.memo.encode(fromWif, toPub, "#" + plaintext);
}

test("plaintext memo passes through unchanged (no key)", () => {
  assert.equal(resolveMemoDestination(ADDR), ADDR);
});

test("plaintext memo passes through unchanged (key present)", () => {
  assert.equal(resolveMemoDestination(ADDR, wif), ADDR);
});

test("encrypted memo round-trips to the plaintext destination", () => {
  const enc = encrypt(ADDR);
  assert.ok(enc.startsWith("#"), "encoded memo must be '#'-prefixed ciphertext");
  assert.notEqual(enc, "#" + ADDR, "must actually be encrypted, not the plaintext");
  assert.equal(resolveMemoDestination(enc, wif), ADDR);
});

test("consensus determinism: independent encryptions of the same address resolve identically", () => {
  // Different nonces each time -> different ciphertext, but the SAME plaintext, so every
  // operator holding the key derives the SAME destination (and thus the same canonical digest).
  const a = encrypt(ADDR);
  const b = encrypt(ADDR);
  assert.notEqual(a, b, "two encryptions should differ (fresh nonce)");
  assert.equal(resolveMemoDestination(a, wif), resolveMemoDestination(b, wif));
  assert.equal(resolveMemoDestination(a, wif), ADDR);
});

test("encrypted memo with NO key resolves to '' (fail-closed -> auto-refund)", () => {
  const enc = encrypt(ADDR);
  assert.equal(resolveMemoDestination(enc), "");
  assert.equal(resolveMemoDestination(enc, undefined), "");
});

test("wrong memo key never yields the real destination", () => {
  const enc = encrypt(ADDR);
  // Decrypting with a foreign key must fail closed — never leak the true address.
  assert.notEqual(resolveMemoDestination(enc, otherWif), ADDR);
});

test("malformed ciphertext resolves to '' (fail-closed)", () => {
  assert.equal(resolveMemoDestination("#not-valid-base58-@@@", wif), "");
  assert.equal(resolveMemoDestination("#", wif), "");
});

test("decrypted whitespace is trimmed", () => {
  const enc = encrypt("  " + ADDR + "  ");
  assert.equal(resolveMemoDestination(enc, wif), ADDR);
});
