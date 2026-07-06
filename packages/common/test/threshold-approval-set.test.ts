import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalSet } from "../src/threshold";
import type { Approval } from "../src/types";

// The threshold gate is what makes the bridge an N-of-M federation rather than a single
// signer: a mint/release may broadcast only once T DISTINCT, KNOWN operators have approved
// the same action digest. These assert distinctness, known-operator gating, exact count and
// per-action isolation directly (the orchestration spike only uses it as a dependency).

const ap = (actionId: string, operatorId: string): Approval => ({ actionId, operatorId, signature: `sig-${operatorId}` });

test("an approval from an unknown operator is rejected and does not count", () => {
  const set = new ApprovalSet(2, ["op-1", "op-2", "op-3"]);
  assert.equal(set.add(ap("A", "intruder")), false, "unknown operator must be refused");
  assert.equal(set.count("A"), 0);
});

test("a duplicate approval from the same operator is refused (one vote per operator)", () => {
  const set = new ApprovalSet(2, ["op-1", "op-2", "op-3"]);
  assert.equal(set.add(ap("A", "op-1")), true);
  assert.equal(set.add(ap("A", "op-1")), false, "a second approval from op-1 must not double-count");
  assert.equal(set.count("A"), 1, "a repeated operator cannot inflate the count toward threshold");
  assert.equal(set.isMet("A"), false);
});

test("threshold is met exactly at T distinct known operators", () => {
  const set = new ApprovalSet(2, ["op-1", "op-2", "op-3"]);
  set.add(ap("A", "op-1"));
  assert.equal(set.isMet("A"), false, "one approval is under a 2-of-N threshold");
  set.add(ap("A", "op-2"));
  assert.equal(set.count("A"), 2);
  assert.equal(set.isMet("A"), true, "two distinct approvals meet a 2-of-N threshold");
});

test("approvals for one action never count toward another (per-action isolation)", () => {
  const set = new ApprovalSet(2, ["op-1", "op-2", "op-3"]);
  set.add(ap("A", "op-1"));
  set.add(ap("B", "op-2"));
  assert.equal(set.count("A"), 1);
  assert.equal(set.count("B"), 1);
  assert.equal(set.isMet("A"), false, "one approval each on two actions must not combine into a quorum");
});

test("approvals() returns exactly the accepted approvals for the action", () => {
  const set = new ApprovalSet(3, ["op-1", "op-2"]);
  set.add(ap("A", "op-1"));
  set.add(ap("A", "op-2"));
  set.add(ap("A", "intruder")); // refused
  const ops = set.approvals("A").map((a) => a.operatorId).sort();
  assert.deepEqual(ops, ["op-1", "op-2"]);
  assert.deepEqual(set.approvals("unseen"), [], "an action with no approvals returns an empty set");
});
