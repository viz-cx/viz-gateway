import { test } from "node:test";
import assert from "node:assert/strict";
import { planChildren } from "../src/policy";
import type { OutboxRecord } from "@gateway/common";

const base: OutboxRecord = {
  id: "f".repeat(64), direction: "PEG_OUT", remoteChain: "GRAM",
  recipient: "ghost", sender: "EQ" + "B".repeat(46),
  amountMilliViz: 100000n, feeMilliViz: 0n, digest: "PARENTDIGEST",
  status: "HELD", attempts: 0, lastError: "RETURN_INVALID_DEST",
  txid: null, createdAt: 0, updatedAt: 0, nextAttemptAt: 0, parentId: null,
};
const ctx = { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n, refundFeeMilliViz: 5000n };

test("PEG_OUT RETURN_INVALID_DEST spawns a GRAM_RETURN child = gross - fee, back to sender", () => {
  const [c] = planChildren(base, "REFUNDING", ctx);
  assert.equal(c.id, "f".repeat(64) + ":return");
  assert.equal(c.direction, "GRAM_RETURN");
  assert.equal(c.recipient, base.sender);
  assert.equal(c.amountMilliViz, 95000n);
  assert.equal(c.digest, "PARENTDIGEST:return");
  assert.equal(c.parentId, base.id);
});

test("dust peg-out (<= fee) spawns no child", () => {
  assert.deepEqual(planChildren({ ...base, amountMilliViz: 5000n }, "REFUNDING", ctx), []);
});

test("a valid PEG_OUT (no RETURN marker) spawns nothing", () => {
  assert.deepEqual(planChildren({ ...base, lastError: null }, "REFUNDING", ctx), []);
});
