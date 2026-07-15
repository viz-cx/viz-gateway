import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "viz-js-lib/lib/auth/ecc";
import type { OperatorRef } from "@gateway/common";
import { resolveOperatorId } from "../src/resolveOperatorId";

function op(id: string, seed: string): OperatorRef {
  return {
    id,
    vizPubkey: PrivateKey.fromSeed(seed).toPublicKey().toString(),
    tonPubkey: "",
    solanaPubkey: "",
  };
}

const op1 = op("op-1", "op-1-seed");
const op2 = op("op-2", "op-2-seed");
const op3 = op("op-3", "op-3-seed");
const operators = [op1, op2, op3];

const wifOf = (seed: string): string => PrivateKey.fromSeed(seed).toWif();

test("derives the operator id from the key with no OPERATOR_ID supplied", () => {
  const warnings: string[] = [];
  const id = resolveOperatorId(wifOf("op-2-seed"), operators, undefined, (m) => warnings.push(m));
  assert.equal(id, "op-2");
  assert.deepEqual(warnings, []); // silent when unset
});

test("a matching OPERATOR_ID resolves silently", () => {
  const warnings: string[] = [];
  const id = resolveOperatorId(wifOf("op-3-seed"), operators, "op-3", (m) => warnings.push(m));
  assert.equal(id, "op-3");
  assert.deepEqual(warnings, []);
});

test("a disagreeing OPERATOR_ID warns and the key wins", () => {
  const warnings: string[] = [];
  const id = resolveOperatorId(wifOf("op-2-seed"), operators, "op-3", (m) => warnings.push(m));
  assert.equal(id, "op-2"); // key is authoritative
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /OPERATOR_ID='op-3'/);
  assert.match(warnings[0]!, /labeled 'op-2'/);
});

test("whitespace-only OPERATOR_ID is treated as unset", () => {
  const warnings: string[] = [];
  const id = resolveOperatorId(wifOf("op-1-seed"), operators, "   ", (m) => warnings.push(m));
  assert.equal(id, "op-1");
  assert.deepEqual(warnings, []);
});

test("a key absent from the manifest fails fast", () => {
  assert.throws(
    () => resolveOperatorId(wifOf("stranger-seed"), operators, undefined, () => {}),
    /is not in federation\.json's operator set/,
  );
});
