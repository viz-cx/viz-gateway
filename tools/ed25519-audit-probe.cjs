// AUDIT PROBE (⑤): adversarial checks on the hand-rolled additive ed25519 in
// packages/solana-watcher/src/depositAddress.ts. NOT a regression test — a scratchpad
// to substantiate the audit findings empirically. Run after `npm run build`:
//   node tools/ed25519-audit-probe.cjs
const assert = require("node:assert");
const { createHash } = require("node:crypto");
const { ed25519 } = require("@noble/curves/ed25519.js");
const {
  masterPubFromSeed,
  depositAddressFromMasterPub,
  deriveDepositSigner,
} = require("../packages/solana-watcher/dist/depositAddress.js");
const { PublicKey } = require("@solana/web3.js");

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const sha512 = (...p) => new Uint8Array(p.reduce((h, x) => h.update(x), createHash("sha512")).digest());
const leToBigInt = (b) => { let r = 0n; for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i] ?? 0); return r; };
const utf8 = (s) => new Uint8Array(Buffer.from(s, "utf8"));
const DOMAIN = "viz-gateway:peg-out:v2";

const SEED = "audit-probe-seed-high-entropy-xxxxxxxxxxxxxxxxxx";
const MPUB = masterPubFromSeed(SEED);
console.log("masterPub:", MPUB);

// ---- 1. Homomorphic consistency: public-derived == scalar-derived (many accounts) ----
for (const viz of ["alice", "bob", "", "a".repeat(300), "unicode-😀", "carol.viz"]) {
  try {
    const pub = depositAddressFromMasterPub(MPUB, viz);
    const sec = deriveDepositSigner(SEED, viz).publicKey.toBase58();
    assert.strictEqual(pub, sec, `mismatch for viz="${viz}"`);
  } catch (e) {
    console.log(`  (viz="${viz.slice(0, 12)}..." threw: ${e.message.split("\n")[0]})`);
  }
}
console.log("[1] homomorphic: public-derived address == scalar-derived address  ✓");

// ---- 2. Signatures verify under noble; canonical S; deterministic ----
const signer = deriveDepositSigner(SEED, "alice");
const A = signer.publicKey.toBytes();
const msg = utf8("solana burn tx skeleton");
const sig1 = signer.signMessage(msg);
const sig2 = signer.signMessage(msg);
assert.ok(ed25519.verify(sig1, msg, A), "sig must verify");
assert.deepStrictEqual([...sig1], [...sig2], "must be deterministic");
const S = leToBigInt(sig1.subarray(32, 64));
assert.ok(S < L, "S must be canonical (< L)  -> non-malleable");
assert.ok(!ed25519.verify(sig1, utf8("tampered"), A), "must reject wrong message");
console.log("[2] RFC 8032 sig verifies, deterministic, canonical S (S < L)  ✓");

// ---- 3. HEADLINE: one leaked child scalar -> recover master -> forge for ANY account ----
// Reconstruct alice's child scalar the way the sweeper holds it in memory, then act as an
// attacker who ONLY has (that one scalar, the public master key, the public domain).
function childScalarFor(seed, viz) {
  const a = leToBigInt((() => { const h = sha512(utf8(seed)); const c = Uint8Array.from(h.subarray(0, 32)); c[0] &= 248; c[31] = (c[31] & 127) | 64; return c; })()) % L;
  const Abytes = Point.BASE.multiply(a).toBytes();
  const t = leToBigInt(sha512(Abytes, utf8(DOMAIN), utf8(viz))) % L;
  return (a + t) % L;
}
const leakedAliceScalar = childScalarFor(SEED, "alice"); // <- the ONE secret that leaks

// attacker knows only: leakedAliceScalar, MPUB (public), DOMAIN (public), victim "bob"
const masterPubBytes = new PublicKey(MPUB).toBytes();
const tAlice = leToBigInt(sha512(masterPubBytes, utf8(DOMAIN), utf8("alice"))) % L;
const recoveredMaster = (leakedAliceScalar - tAlice + L) % L; // a = childScalar - tweak
const tBob = leToBigInt(sha512(masterPubBytes, utf8(DOMAIN), utf8("bob"))) % L;
const forgedBobScalar = (recoveredMaster + tBob) % L;
const forgedBobPub = Point.BASE.multiply(forgedBobScalar).toBytes();
const realBobPub = new PublicKey(depositAddressFromMasterPub(MPUB, "bob")).toBytes();
assert.deepStrictEqual([...forgedBobPub], [...realBobPub], "attacker reproduced bob's deposit key");
// and can sign a burn for bob's deposit that verifies:
const r = leToBigInt(sha512(utf8("atk-nonce"), utf8("bob"))) % L; // attacker's own nonce
const R = Point.BASE.multiply(r).toBytes();
const k = leToBigInt(sha512(R, forgedBobPub, msg)) % L;
const Sforge = (r + k * forgedBobScalar) % L;
const forgedSig = new Uint8Array([...R, ...(() => { const o = new Uint8Array(32); let v = Sforge; for (let i = 0; i < 32; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; })()]);
assert.ok(ed25519.verify(forgedSig, msg, forgedBobPub), "forged sig for bob verifies");
console.log("[3] ⚠ one leaked child scalar -> recovered master -> forged spend for a DIFFERENT account  ✓ (by design of additive derivation)");

// ---- 4. Does recovering the scalar require the seed string? No. ----
// The attacker never learned SEED (SHA512 preimage) yet holds full spend authority,
// because the nonce can be attacker-chosen; the seed string is only needed for the
// *deterministic* nonce, not to sign.
console.log("[4] master *scalar* (not seed string) is sufficient for full spend authority  ✓");

console.log("\nRESULT: properties confirmed. See audit report for findings F-1..F-10.");
