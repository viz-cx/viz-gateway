import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "viz-js-lib/lib/auth/ecc";
import { signChallenge } from "@gateway/viz-watcher/dist/challenge";
import { SignerRegistry } from "../src/registry";
import type { OperatorRef } from "@gateway/common";

function keyFor(seed: string) {
  const pk = PrivateKey.fromSeed(seed);
  return { wif: pk.toWif(), pub: pk.toPublicKey().toString() };
}
const k1 = keyFor("op-1-seed");
const k2 = keyFor("op-2-seed");
const operators: OperatorRef[] = [
  { id: "op-1", vizPubkey: k1.pub, tonPubkey: "", solanaPubkey: "" },
  { id: "op-2", vizPubkey: k2.pub, tonPubkey: "", solanaPubkey: "" },
];

function reg(now: () => number) {
  return new SignerRegistry(operators, 60000, 30000, now);
}

test("valid registration is accepted and appears in live()", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-2");
  const sig = signChallenge("op-2", "http://op-2:8090", nonce, k2.wif);
  const out = r.register("op-2", "http://op-2:8090", nonce, sig);
  assert.equal(out.url, "http://op-2:8090");
  assert.deepEqual(r.live().map((x) => x.operatorId), ["op-2"]);
  assert.deepEqual(r.count(), { registered: 1, expected: 2 });
});

test("live() returns registrations in federation operator order, not arrival order", () => {
  let t = 1000;
  const r = reg(() => t);
  for (const [id, k] of [["op-2", k2], ["op-1", k1]] as const) {
    const { nonce } = r.issueChallenge(id);
    r.register(id, `http://${id}:8090`, nonce, signChallenge(id, `http://${id}:8090`, nonce, k.wif));
  }
  assert.deepEqual(r.live().map((x) => x.operatorId), ["op-1", "op-2"]);
});

test("a key labeled for a different operator is rejected (loud mismatch)", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-1");
  const sig = signChallenge("op-1", "http://op-1:8090", nonce, k2.wif); // op-2's key claims op-1
  assert.throws(() => r.register("op-1", "http://op-1:8090", nonce, sig), /key mismatch/);
});

test("a key outside the federation set is rejected", () => {
  let t = 1000;
  const r = reg(() => t);
  const stranger = keyFor("not-in-federation");
  const { nonce } = r.issueChallenge("op-1");
  const sig = signChallenge("op-1", "http://op-1:8090", nonce, stranger.wif);
  assert.throws(() => r.register("op-1", "http://op-1:8090", nonce, sig), /not in the federation/);
});

test("replayed nonce is rejected (single-use)", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-1");
  const sig = signChallenge("op-1", "http://op-1:8090", nonce, k1.wif);
  r.register("op-1", "http://op-1:8090", nonce, sig);
  assert.throws(() => r.register("op-1", "http://op-1:8090", nonce, sig), /nonce/);
});

test("expired nonce is rejected", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-1");
  const sig = signChallenge("op-1", "http://op-1:8090", nonce, k1.wif);
  t += 30001; // past nonceTtlMs
  assert.throws(() => r.register("op-1", "http://op-1:8090", nonce, sig), /expired/);
});

test("expired lease drops out of live()", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-1");
  r.register("op-1", "http://op-1:8090", nonce, signChallenge("op-1", "http://op-1:8090", nonce, k1.wif));
  t += 60001; // past leaseMs
  assert.deepEqual(r.live(), []);
});

test("unknown operator cannot get a challenge", () => {
  const r = reg(() => 1000);
  assert.throws(() => r.issueChallenge("op-9"), /unknown operator/);
});

test("roster() reports live vs missing in manifest order", () => {
  let t = 1000;
  const r = reg(() => t);
  assert.deepEqual(r.roster(), { live: [], missing: ["op-1", "op-2"] });
  const { nonce } = r.issueChallenge("op-2");
  r.register("op-2", "http://op-2:8090", nonce, signChallenge("op-2", "http://op-2:8090", nonce, k2.wif));
  assert.deepEqual(r.roster(), { live: ["op-2"], missing: ["op-1"] });
});

test("roster() drops an expired lease back to missing", () => {
  let t = 1000;
  const r = reg(() => t);
  const { nonce } = r.issueChallenge("op-1");
  r.register("op-1", "http://op-1:8090", nonce, signChallenge("op-1", "http://op-1:8090", nonce, k1.wif));
  assert.deepEqual(r.roster(), { live: ["op-1"], missing: ["op-2"] });
  t += 60001; // past leaseMs
  assert.deepEqual(r.roster(), { live: [], missing: ["op-1", "op-2"] });
});
