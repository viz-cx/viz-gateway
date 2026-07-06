import { test } from "node:test";
import assert from "node:assert/strict";
import { sealKeystore, openKeystore, constantTimeEqual, type KdfParams } from "../src/keystore";

// Light scrypt cost so the suite stays fast; the crypto path is identical to prod's.
const FAST: KdfParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };

const SECRETS = {
  vizSigningWif: "5JtestWifValue",
  gramSignerMnemonic: "abandon ability able about above absent absorb abstract",
  solanaSignerSecret: "[1,2,3,4,5]",
};

test("round-trip: sealed secrets decrypt back identically", () => {
  const ks = sealKeystore(SECRETS, "correct horse battery staple", FAST);
  const out = openKeystore(ks, "correct horse battery staple");
  assert.deepEqual(out, SECRETS);
});

test("only present fields are sealed", () => {
  const ks = sealKeystore({ vizSigningWif: "onlyviz" }, "pw", FAST);
  const out = openKeystore(ks, "pw");
  assert.deepEqual(out, { vizSigningWif: "onlyviz" });
});

test("sealing with no secrets throws", () => {
  assert.throws(() => sealKeystore({}, "pw", FAST), /nothing to seal/i);
});

test("empty passphrase is rejected", () => {
  assert.throws(() => sealKeystore(SECRETS, "", FAST), /passphrase/i);
});

test("wrong passphrase fails to decrypt", () => {
  const ks = sealKeystore(SECRETS, "right-passphrase", FAST);
  assert.throws(() => openKeystore(ks, "wrong-passphrase"), /decryption failed/i);
});

test("tampered ciphertext is rejected by the auth tag", () => {
  const ks = sealKeystore(SECRETS, "pw", FAST);
  const raw = Buffer.from(ks.ciphertext, "base64");
  raw[0] ^= 0xff; // flip a bit
  const tampered = { ...ks, ciphertext: raw.toString("base64") };
  assert.throws(() => openKeystore(tampered, "pw"), /decryption failed/i);
});

test("tampered salt (→ wrong derived key) is rejected", () => {
  const ks = sealKeystore(SECRETS, "pw", FAST);
  const salt = Buffer.from(ks.salt, "base64");
  salt[0] ^= 0xff;
  const tampered = { ...ks, salt: salt.toString("base64") };
  assert.throws(() => openKeystore(tampered, "pw"), /decryption failed/i);
});

test("an unsupported version is rejected", () => {
  const ks = sealKeystore(SECRETS, "pw", FAST);
  assert.throws(() => openKeystore({ ...ks, v: 2 }, "pw"), /unsupported version/i);
});

test("a malformed envelope (missing ciphertext) is rejected", () => {
  const ks = sealKeystore(SECRETS, "pw", FAST) as unknown as Record<string, unknown>;
  delete ks.ciphertext;
  assert.throws(() => openKeystore(ks, "pw"), /malformed/i);
});

test("two seals of the same secrets differ (fresh salt + iv)", () => {
  const a = sealKeystore(SECRETS, "pw", FAST);
  const b = sealKeystore(SECRETS, "pw", FAST);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test("constantTimeEqual matches and rejects", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
});
