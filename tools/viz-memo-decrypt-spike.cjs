// SPIKE: encrypted peg-in memo support (offline, end-to-end over the REAL resolver + canonical).
//
// VIZ memos may be encrypted to the gate account's memo key (Graphene: an encrypted memo is
// base58 text prefixed with '#'). This proves the gateway can accept them WITHOUT weakening the
// federation's consensus or fail-closed guarantees:
//
//   (1) DECRYPT: an encrypted memo, decrypted with the gate account's memo key, resolves to the
//       same plaintext destination a wallet would have sent in the clear.
//   (2) CONSENSUS EQUIVALENCE: the canonical digest binds the RESOLVED recipient, so an encrypted
//       deposit and the equivalent plaintext deposit to the same address produce the IDENTICAL
//       digest — every operator holding the memo key signs the same thing.
//   (3) LIVENESS, NOT THEFT: an operator MISSING the key resolves "" (destinationValid=false) and
//       routes to auto-refund — a stall that ends in a refund to the sender, never a wrong mint.
//   (4) FAIL-CLOSED: a wrong key or a malformed blob resolves "" (never leaks the true address).
//
// Run (after `npm run build`): node tools/viz-memo-decrypt-spike.cjs
const assert = require("node:assert");
const viz = require("viz-js-lib");
const { PrivateKey } = require("viz-js-lib/lib/auth/ecc");
const { canonicalPegIn, isValidRemoteAddress } = require("@gateway/common");
const { resolveMemoDestination } = require("../packages/viz-watcher/dist/memo");

// Gate account memo keypair (seed-derived; NOT a real key). A second, foreign key models an
// operator holding the wrong key.
const memoWif = PrivateKey.fromSeed("viz-gateway memo spike gate key").toWif();
const memoPub = viz.auth.wifToPublic(memoWif);
const foreignWif = PrivateKey.fromSeed("viz-gateway memo spike foreign key").toWif();

// A real-shaped TON destination so isValidRemoteAddress accepts the resolved value
// (GRAM regex: /^[EU]Q[A-Za-z0-9_-]{46}$/ — 'EQ' + exactly 46 chars).
const ADDR = "EQ" + "CfGcOZ1234567890abcdefghijklmnopqrstuvwxyzABCD";
assert.strictEqual(isValidRemoteAddress("GRAM", ADDR), true, "fixture address must be a valid GRAM destination");

// A wallet marks a memo for encryption with a leading '#'; encode returns '#'-prefixed ciphertext.
const encrypted = viz.memo.encode(memoWif, memoPub, "#" + ADDR);
assert.ok(encrypted.startsWith("#") && encrypted !== "#" + ADDR, "memo must be genuinely encrypted");

const baseDep = {
  trxId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  opIndex: 0,
  blockNum: 81_700_000,
  from: "alice",
  to: "gram.gate",
  amountMilliViz: 1_500_000n,
  remoteChain: "GRAM",
};

// Build a deposit exactly as VizJsChain does: resolve the memo, then canonicalize.
function readDeposit(rawMemo, wif) {
  const resolved = resolveMemoDestination(rawMemo, wif);
  const destinationValid = isValidRemoteAddress(baseDep.remoteChain, resolved);
  return {
    ...baseDep,
    remoteDestination: destinationValid ? resolved : "",
    destinationValid,
  };
}

// (1) DECRYPT ---------------------------------------------------------------------------------
const encDep = readDeposit(encrypted, memoWif);
assert.strictEqual(encDep.destinationValid, true, "operator with the key must validate the destination");
assert.strictEqual(encDep.remoteDestination, ADDR, "decrypted destination must equal the plaintext address");
console.log("[decrypt] encrypted memo decrypts to the plaintext destination OK");

// (2) CONSENSUS EQUIVALENCE -------------------------------------------------------------------
const plainDep = readDeposit(ADDR, memoWif); // plaintext memo, same address
const encAction = canonicalPegIn(encDep);
const plainAction = canonicalPegIn(plainDep);
assert.strictEqual(
  encAction.digest,
  plainAction.digest,
  "encrypted and plaintext deposits to the same address must produce the identical canonical digest",
);
// Two independent encryptions (fresh nonce) also converge on the same digest.
const encAction2 = canonicalPegIn(readDeposit(viz.memo.encode(memoWif, memoPub, "#" + ADDR), memoWif));
assert.strictEqual(encAction2.digest, encAction.digest, "cross-operator digest determinism (fresh nonce)");
console.log("[consensus] digest binds the RESOLVED recipient — encrypted ≡ plaintext ≡ deterministic OK");

// (3) LIVENESS, NOT THEFT: operator missing the key -> refund path ----------------------------
const noKeyDep = readDeposit(encrypted, undefined);
assert.strictEqual(noKeyDep.destinationValid, false, "operator WITHOUT the key must not validate");
assert.strictEqual(noKeyDep.remoteDestination, "", "no-key read collapses to the '' refund sentinel");
assert.strictEqual(canonicalPegIn(noKeyDep).recipient, "", "no-key action canonicalizes recipient to ''");
console.log("[liveness] missing key -> destinationValid=false -> auto-refund (no wrong mint) OK");

// (4) FAIL-CLOSED: wrong key / malformed blob -------------------------------------------------
assert.notStrictEqual(resolveMemoDestination(encrypted, foreignWif), ADDR, "wrong key must never yield the address");
assert.strictEqual(readDeposit(encrypted, foreignWif).destinationValid, false, "wrong key -> invalid -> refund");
assert.strictEqual(resolveMemoDestination("#not-base58-@@@", memoWif), "", "malformed ciphertext -> ''");
console.log("[fail-closed] wrong key and malformed blob resolve to '' OK");

console.log("\nviz-memo-decrypt-spike: ALL PASS");
