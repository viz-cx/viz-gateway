import { test } from "node:test";
import assert from "node:assert/strict";
import { planChildren } from "../src/policy";
import type { OutboxRecord } from "@gateway/common";

const baseRec: OutboxRecord = {
  id: "t1:0",
  direction: "PEG_IN",
  remoteChain: "SOLANA",
  recipient: "remote-user",
  sender: "viz-user",
  amountMilliViz: 10000n,
  feeMilliViz: 500n,
  digest: "abc123",
  status: "CONFIRMED",
  attempts: 1,
  lastError: null,
  txid: null,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
  parentId: null,
};

test("FEE_SWEEP child inherits parent remoteChain", () => {
  const children = planChildren(baseRec, "CONFIRMED", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 500n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].direction, "FEE_SWEEP");
  assert.equal(children[0].remoteChain, "SOLANA");
});

test("REFUND child inherits parent remoteChain", () => {
  const refundRec = { ...baseRec, status: "REFUNDING" as const };
  const children = planChildren(refundRec, "REFUNDING", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 0n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].direction, "REFUND");
  assert.equal(children[0].remoteChain, "SOLANA");
});

test("FEE_SWEEP with GRAM remoteChain", () => {
  const gramRec = { ...baseRec, remoteChain: "GRAM" as const };
  const children = planChildren(gramRec, "CONFIRMED", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 500n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].remoteChain, "GRAM");
});

test("No children when sweepAmountMilliViz is zero", () => {
  const children = planChildren(baseRec, "CONFIRMED", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 0n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 0);
});

test("No children for non-CONFIRMED status", () => {
  const queuedRec = { ...baseRec, status: "QUEUED" as const };
  const children = planChildren(queuedRec, "QUEUED", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 500n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 0);
});

test("No children for non-PEG_IN direction", () => {
  const pegOutRec = { ...baseRec, direction: "PEG_OUT" as const };
  const children = planChildren(pegOutRec, "CONFIRMED", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 500n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 0);
});

test("REFUND has no remoteChain when parent has none", () => {
  const noChainRec = { ...baseRec, remoteChain: undefined, status: "REFUNDING" as const };
  const children = planChildren(noChainRec, "REFUNDING", {
    feesGateAccount: "fees.gate",
    sweepAmountMilliViz: 0n,
    refundFeeMilliViz: 0n,
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].direction, "REFUND");
  assert.equal(children[0].remoteChain, undefined);
});
