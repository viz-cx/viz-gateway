import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorityHash,
  buildActiveAuthority,
  parseOperators,
  serializeOperators,
} from "../src/rotation";

const VIZ1 = "VIZ1111111111111111111111111111111111111111111111111";
const VIZ2 = "VIZ2222222222222222222222222222222222222222222222222";
const TON1 = "a".repeat(64);
const TON2 = "b".repeat(64);

test("parseOperators accepts both the 2-field and 3-field forms", () => {
  assert.deepEqual(parseOperators(`op-1=${VIZ1}:${TON1}`), [
    { id: "op-1", vizPubkey: VIZ1, tonPubkey: TON1, solanaPubkey: "" },
  ]);
  assert.deepEqual(parseOperators(`op-1=${VIZ1}:${TON1}:SOL1`), [
    { id: "op-1", vizPubkey: VIZ1, tonPubkey: TON1, solanaPubkey: "SOL1" },
  ]);
});

test("parseOperators rejects entries missing '='", () => {
  assert.throws(() => parseOperators(`op-1${VIZ1}:${TON1}`), /missing '='/);
});

test("parseOperators rejects the wrong field count", () => {
  assert.throws(() => parseOperators(`op-1=${VIZ1}`), /2 or 3 fields/);
  assert.throws(() => parseOperators(`op-1=${VIZ1}:${TON1}:SOL:extra`), /2 or 3 fields/);
});

// An empty id or key would silently produce a garbage authority and could brick the account.
test("parseOperators rejects an entry with an empty id, vizPub, or tonPub", () => {
  assert.throws(() => parseOperators(`=${VIZ1}:${TON1}`), /incomplete/);
  assert.throws(() => parseOperators(`op-1=:${TON1}`), /incomplete/);
  assert.throws(() => parseOperators(`op-1=${VIZ1}:`), /incomplete/);
});

test("parseOperators/serializeOperators round-trip, omitting an absent Solana key", () => {
  const two = `op-1=${VIZ1}:${TON1},op-2=${VIZ2}:${TON2}`;
  assert.equal(serializeOperators(parseOperators(two)), two);
  const three = `op-1=${VIZ1}:${TON1}:SOL1`;
  assert.equal(serializeOperators(parseOperators(three)), three);
});

test("buildActiveAuthority is keys-only, weight 1, sorted", () => {
  // VIZ2 listed first so we prove the output is sorted, not input-ordered.
  const ops = parseOperators(`op-2=${VIZ2}:${TON2},op-1=${VIZ1}:${TON1}`);
  const auth = buildActiveAuthority(ops, 2);
  assert.deepEqual(auth, {
    weight_threshold: 2,
    account_auths: [],
    key_auths: [
      [VIZ1, 1],
      [VIZ2, 1],
    ],
  });
});

// threshold > N is unsatisfiable: it would lock the gateway account out permanently.
test("buildActiveAuthority rejects a threshold above the operator count", () => {
  const ops = parseOperators(`op-1=${VIZ1}:${TON1},op-2=${VIZ2}:${TON2}`);
  assert.throws(() => buildActiveAuthority(ops, 3), /threshold 3 exceeds operator count 2/);
  assert.doesNotThrow(() => buildActiveAuthority(ops, 2));
});

test("buildActiveAuthority rejects a threshold below 1", () => {
  const ops = parseOperators(`op-1=${VIZ1}:${TON1}`);
  assert.throws(() => buildActiveAuthority(ops, 0), /threshold must be >= 1/);
});

// A duplicate key would inflate one operator's effective weight and break M-of-N.
test("buildActiveAuthority rejects a duplicate vizPubkey", () => {
  const ops = parseOperators(`op-1=${VIZ1}:${TON1},op-2=${VIZ1}:${TON2}`);
  assert.throws(() => buildActiveAuthority(ops, 2), /duplicate vizPubkey/);
});

test("authorityHash is order-independent but threshold-sensitive", () => {
  const a = buildActiveAuthority(parseOperators(`op-1=${VIZ1}:${TON1},op-2=${VIZ2}:${TON2}`), 2);
  const b = buildActiveAuthority(parseOperators(`op-2=${VIZ2}:${TON2},op-1=${VIZ1}:${TON1}`), 2);
  assert.equal(authorityHash(a), authorityHash(b));

  const c = buildActiveAuthority(parseOperators(`op-1=${VIZ1}:${TON1},op-2=${VIZ2}:${TON2}`), 1);
  assert.notEqual(authorityHash(a), authorityHash(c), "threshold must be bound into the hash");
});
