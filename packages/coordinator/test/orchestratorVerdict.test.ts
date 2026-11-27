import { test } from "node:test";
import assert from "node:assert/strict";
import type { CanonicalAction } from "@gateway/common";
import { Orchestrator, type Broadcaster, type SignerClient } from "../src/orchestrator";

// The dispatcher refunds a PEG_IN only on a 200 verdict from /submit, i.e. only when
// Orchestrator.process RETURNS. A throw becomes HTTP 500 = "retry, never refund". These tests
// pin which failures return (safe to count toward a refund) and which throw.

const action: CanonicalAction = {
  direction: "PEG_IN", id: "trx:0", remoteChain: "GRAM", recipient: "EQ..", amountMilliViz: 100_000n, digest: "d",
};
const proposal = { orderAddr: "EQorder" } as never;

function broadcaster(over: Partial<Broadcaster>): Broadcaster & { calls: string[] } {
  const calls: string[] = [];
  const b: Broadcaster = {
    actionExecuted: async () => ({ executed: false }),
    buildProposal: async () => ({ proposal, feeMilliViz: 45_000n }),
    broadcast: async () => "EQorder",
    ...over,
  };
  return {
    calls,
    actionExecuted: (a) => (calls.push("executed"), b.actionExecuted(a)),
    buildProposal: (a) => (calls.push("build"), b.buildProposal(a)),
    broadcast: (a, p, s) => (calls.push("broadcast"), b.broadcast(a, p, s)),
  };
}
const signer = (operatorId: string, ok = true): SignerClient & { asked: number } => {
  const s = {
    operatorId,
    asked: 0,
    approve: async () => {
      s.asked++;
      if (!ok) throw new Error("refused");
      return { actionId: action.id, operatorId, signature: "sig" };
    },
  };
  return s;
};
const ops = ["op-1", "op-2", "op-3"];

test("actionExecuted failing THROWS (HTTP 500): nobody checked the chain, so no refund verdict", async () => {
  const b = broadcaster({ actionExecuted: async () => { throw new Error("toncenter 503"); } });
  const s = signer("op-2");
  await assert.rejects(new Orchestrator(2, ops, [s], b).process(action), /toncenter 503/);
  assert.deepEqual(b.calls, ["executed"]);
  assert.equal(s.asked, 0);
});

test("buildProposal failing RETURNS broadcast:false and asks no signer", async () => {
  const b = broadcaster({ buildProposal: async () => { throw new Error("PEG_IN trx:0 below minimum (refund)"); } });
  const s = signer("op-2");
  const r = await new Orchestrator(2, ops, [s], b).process(action);
  assert.equal(r.broadcast, false);
  assert.equal(r.approvals, 0);
  assert.match(r.error ?? "", /below minimum/);
  assert.deepEqual(b.calls, ["executed", "build"]);
  assert.equal(s.asked, 0);
});

test("already executed short-circuits to broadcast:true even when the fee rebuild fails", async () => {
  const b = broadcaster({
    actionExecuted: async () => ({ executed: true, txid: "EQorder" }),
    buildProposal: async () => { throw new Error("rpc down"); },
  });
  const s = signer("op-2");
  const r = await new Orchestrator(2, ops, [s], b).process(action);
  assert.equal(r.broadcast, true);
  assert.equal(r.txid, "EQorder");
  assert.equal(s.asked, 0);
  assert.ok(!b.calls.includes("broadcast"));
});

test("below threshold RETURNS broadcast:false and never broadcasts", async () => {
  const b = broadcaster({});
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3", false)], b).process(action);
  assert.equal(r.broadcast, false);
  assert.equal(r.approvals, 1);
  assert.ok(!b.calls.includes("broadcast"));
});

test("a broadcast error RETURNS broadcast:false with the error", async () => {
  const b = broadcaster({ broadcast: async () => { throw new Error("order not executed in time"); } });
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3")], b).process(action);
  assert.equal(r.broadcast, false);
  assert.match(r.error ?? "", /not executed in time/);
});

test("the on-chain check always runs before anything is built or signed", async () => {
  const b = broadcaster({});
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3")], b).process(action);
  assert.equal(r.broadcast, true);
  assert.deepEqual(b.calls, ["executed", "build", "broadcast"]);
});
