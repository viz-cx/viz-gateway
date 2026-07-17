import { test } from "node:test";
import assert from "node:assert/strict";
import { planChildren, refundAmount } from "../src/policy";
import type { OutboxRecord } from "@gateway/common";

const base: OutboxRecord = {
  id: "d1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "", sender: "alice",
  amountMilliViz: 100000n, feeMilliViz: 0n, digest: "x", status: "REFUNDING",
  attempts: 0, lastError: null, txid: null, createdAt: 0, updatedAt: 0, nextAttemptAt: 0, parentId: null,
};

test("refundAmount deducts the fee, floored at 0", () => {
  assert.equal(refundAmount(100000n, 5000n), 95000n);
  assert.equal(refundAmount(5000n, 5000n), 0n);
  assert.equal(refundAmount(3000n, 5000n), 0n);
});

test("REFUND child carries gross minus refund fee", () => {
  const kids = planChildren(base, "REFUNDING", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n, refundFeeMilliViz: 5000n });
  assert.equal(kids.length, 1);
  assert.equal(kids[0].direction, "REFUND");
  assert.equal(kids[0].amountMilliViz, 95000n);
});

test("dust (gross <= refund fee) spawns NO refund child", () => {
  const dust = { ...base, amountMilliViz: 4000n };
  const kids = planChildren(dust, "REFUNDING", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n, refundFeeMilliViz: 5000n });
  assert.deepEqual(kids, []);
});
