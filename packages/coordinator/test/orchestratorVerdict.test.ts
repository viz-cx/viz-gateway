import { test } from "node:test";
import assert from "node:assert/strict";
import type { CanonicalAction } from "@gateway/common";
import { BelowMinimumError, Orchestrator, singleFlight, type Broadcaster, type SignerClient } from "../src/orchestrator";

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

test("a transient buildProposal failure THROWS (no verdict) and asks no signer", async () => {
  const b = broadcaster({ buildProposal: async () => { throw new Error("rpc down"); } });
  const s = signer("op-2");
  await assert.rejects(new Orchestrator(2, ops, [s], b).process(action), /rpc down/);
  assert.equal(s.asked, 0);
});

test("below-minimum RETURNS broadcast:false and asks no signer", async () => {
  const b = broadcaster({ buildProposal: async () => { throw new BelowMinimumError("PEG_IN trx:0 below minimum (refund)"); } });
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

/** actionExecuted that answers from a script: one entry per call. */
const scripted = (answers: Array<{ executed: boolean; txid?: string } | Error>) => async () => {
  const a = answers.shift();
  if (!a) throw new Error("unexpected extra actionExecuted call");
  if (a instanceof Error) throw a;
  return a;
};

test("below threshold but the order executed during the round (late on-chain approval): success", async () => {
  const b = broadcaster({ actionExecuted: scripted([{ executed: false }, { executed: true, txid: "EQorder" }]) });
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3", false)], b).process(action);
  assert.equal(r.broadcast, true);
  assert.equal(r.txid, "EQorder");
  assert.equal(r.feeMilliViz, "45000");
});

test("broadcast threw but the mint landed anyway: success, not a failure verdict", async () => {
  const b = broadcaster({
    actionExecuted: scripted([{ executed: false }, { executed: true, txid: "sig" }]),
    broadcast: async () => { throw new Error("send timeout"); },
  });
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3")], b).process(action);
  assert.equal(r.broadcast, true);
  assert.equal(r.txid, "sig");
});

test("a failed round whose closing on-chain check fails THROWS: no failure verdict without it", async () => {
  for (const signers of [[signer("op-2"), signer("op-3", false)], [signer("op-2"), signer("op-3")]]) {
    const b = broadcaster({
      actionExecuted: scripted([{ executed: false }, new Error("rpc down")]),
      broadcast: async () => { throw new Error("send timeout"); },
    });
    await assert.rejects(new Orchestrator(2, ops, signers, b).process(action), /rpc down/);
  }
});

test("a failure verdict is always preceded by a closing on-chain check", async () => {
  const b = broadcaster({});
  await new Orchestrator(2, ops, [signer("op-2", false)], b).process(action);
  assert.deepEqual(b.calls, ["executed", "build", "executed"]);
});

test("threshold-met broadcast failure reports approvals >= threshold (dispatcher treats as no verdict)", async () => {
  const b = broadcaster({ broadcast: async () => { throw new Error("order not executed in time"); } });
  const r = await new Orchestrator(2, ops, [signer("op-2"), signer("op-3")], b).process(action);
  assert.equal(r.broadcast, false);
  assert.ok(r.approvals >= r.threshold);
});

// --- singleFlight: a re-submit joins the running round ---

test("singleFlight: concurrent calls for one key share ONE run and one result", async () => {
  const once = singleFlight<string>();
  let runs = 0;
  let release!: (v: string) => void;
  const run = () => (runs++, new Promise<string>((r) => (release = r)));
  const a = once("trx:0", run);
  const b = once("trx:0", run);
  assert.equal(a, b);
  release("landed");
  assert.deepEqual(await Promise.all([a, b]), ["landed", "landed"]);
  assert.equal(runs, 1);
});

test("singleFlight: different keys run independently; a finished key runs again", async () => {
  const once = singleFlight<number>();
  let runs = 0;
  const run = async () => ++runs;
  assert.deepEqual(await Promise.all([once("a", run), once("b", run)]), [1, 2]);
  assert.equal(await once("a", run), 3);
});

test("singleFlight: a rejected run reaches every joiner and does not poison the key", async () => {
  const once = singleFlight<string>();
  const boom = () => Promise.reject(new Error("rpc down"));
  const [a, b] = [once("k", boom), once("k", boom)];
  await assert.rejects(a, /rpc down/);
  await assert.rejects(b, /rpc down/);
  assert.equal(await once("k", async () => "ok"), "ok");
});

test("singleFlight + orchestrator: a re-submit during a slow round never starts a second round", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  const b = broadcaster({ broadcast: async () => (await gate, "EQorder") });
  const once = singleFlight<Awaited<ReturnType<Orchestrator["process"]>>>();
  const round = () => new Orchestrator(2, ops, [signer("op-2"), signer("op-3")], b).process(action);
  const first = once(action.id, round);
  await new Promise((r) => setImmediate(r)); // let round 1 reach broadcast
  const second = once(action.id, round);
  unblock();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.broadcast, true);
  assert.equal(r2, r1);
  assert.equal(b.calls.filter((c) => c === "build").length, 1);
});
