// SPIKE: the GRAM TON mint proposer is chosen PER-ACTION as the first LIVE
// operator, not pinned to federation operators[0] at boot.
//
// Regression guard for the mainnet incident where a 1500 VIZ peg-in refunded:
// operators[0] (op-1) was the sole designated proposer and its signer was
// offline, so nobody sent `new_order`, every live approver timed out waiting
// for an order that never appeared, approvals stayed 0/2, and the deposit
// refunded. With dynamic selection, op-2 + op-3 (threshold met) complete the
// mint on their own: the first live operator proposes, the rest approve.
//
// Drives the REAL Orchestrator + REAL GramMintBroadcaster against a fake TON
// chain, so it proves the wiring: process() derives the proposer from the SAME
// live-signer snapshot it contacts, guaranteeing proposer-first.
//
// Run: node tools/gram-proposer-fallback-spike.cjs
const assert = require("node:assert");
const { canonicalPegIn } = require("@gateway/common");
const { Orchestrator } = require("../packages/coordinator/dist/orchestrator.js");
const { GramMintBroadcaster } = require("../packages/coordinator/dist/adapters.js");

const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
};

// Fake GramHttpChain: enough surface for buildProposal + broadcast to run offline.
function fakeChain() {
  return {
    isDestinationProvisioned: async () => true,
    orderHashFor: () => "deadbeef",
    nextOrderAddress: async () => ({ orderAddr: "EQorder", seqno: "7" }),
    orderExecuted: async () => true, // let broadcast() confirm immediately
  };
}

// Fake store: a fresh action (no persisted txid) so buildProposal pins a new order.
function fakeStore() {
  return { get: async () => undefined, setStatus: async () => {} };
}

// Fake signer that records the proposer pinned in every proposal it is handed and
// approves under its own id. `contactOrder` records who was asked, in order.
function recordingSigner(operatorId, contactOrder, seen) {
  return {
    operatorId,
    approve: async (action, proposal) => {
      contactOrder.push(operatorId);
      seen.push(proposal.proposerOperatorId);
      return { actionId: action.id, operatorId, signature: `ton:EQorder:0:approve` };
    },
  };
}

const action = canonicalPegIn({
  trxId: "1383712ad91270b46641c78412ac66c9a7f6b7c8",
  opIndex: 0,
  remoteChain: "GRAM",
  remoteDestination: "UQDCB9cdnWdWYYK8cgZDRjtuRQjxAqu8NubXBIcI2vMzHynx",
  amountMilliViz: 1500000n,
});

(async () => {
  const OPERATORS = ["op-1", "op-2", "op-3"];

  // op-1 OFFLINE: only op-2, op-3 registered (in federation order). Threshold 2.
  {
    const contactOrder = [];
    const seen = [];
    const signers = [
      recordingSigner("op-2", contactOrder, seen),
      recordingSigner("op-3", contactOrder, seen),
    ];
    const r = await new Orchestrator(2, OPERATORS, signers, new GramMintBroadcaster(fakeChain(), FEES, fakeStore())).process(action);
    assert.strictEqual(r.broadcast, true, "mint should broadcast with op-2+op-3 (threshold met)");
    assert.strictEqual(r.approvals, 2);
    // Proposer is the first LIVE operator and every signer saw the SAME pinned proposer.
    assert.ok(seen.length >= 1 && seen.every((p) => p === "op-2"), `all proposals pin op-2, saw ${JSON.stringify(seen)}`);
    // Proposer-first: op-2 (the proposer) is the first signer contacted.
    assert.strictEqual(contactOrder[0], "op-2", "designated proposer must be contacted first");
    console.log("[op-1 offline]  proposer=op-2 (first live), contacted first, broadcast=true approvals=2 OK");
  }

  // Only op-3 live, threshold 1: proposer follows the live set, not operators[0].
  {
    const contactOrder = [];
    const seen = [];
    const signers = [recordingSigner("op-3", contactOrder, seen)];
    const r = await new Orchestrator(1, OPERATORS, signers, new GramMintBroadcaster(fakeChain(), FEES, fakeStore())).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.ok(seen.every((p) => p === "op-3"), `all proposals pin op-3, saw ${JSON.stringify(seen)}`);
    console.log("[only op-3 live] proposer=op-3, broadcast=true OK");
  }

  // No live signer: buildProposal fails closed rather than emitting a proposer-less order.
  {
    const b = new GramMintBroadcaster(fakeChain(), FEES, fakeStore());
    await assert.rejects(
      () => b.buildProposal(action, { liveOperatorIds: [] }),
      /no live operator available to propose/,
      "empty live set must throw, not pin an undefined proposer",
    );
    console.log("[no live]        buildProposal throws (no proposer-less order) OK");
  }

  console.log("\nRESULT: the TON mint proposer is the first LIVE operator (proposer-first,");
  console.log("one snapshot for contact order + proposer), so a mint completes whenever the");
  console.log("threshold is met — no deadlock when federation operators[0] is offline.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
