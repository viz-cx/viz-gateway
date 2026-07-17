// SPIKE: TON mint opener FAILOVER at the coordinator level.
//
// There is no single designated proposer: whichever live operator the coordinator
// contacts first while the order is absent OPENS it on-chain (new_order); the rest
// APPROVE. The coordinator contacts live operators sequentially and tolerates a
// signer that fails its turn, so a stuck/unfunded/offline operator does NOT deadlock
// the mint — the opener role fails over to the next operator.
//
// Regression guard for the mainnet incident: a 1500 VIZ peg-in refunded because the
// ONE hardcoded proposer (operators[0] = op-1) was offline and nobody else was allowed
// to open the order. This proves the coordinator now fails over past a broken opener.
//
// It also documents the HARD operational floor honestly: on TON every approval is an
// on-chain tx, so completing a mint still needs `threshold` operators that can transact
// — failover changes WHO opens the order, not how many functional signers you need.
//
// Uses the REAL Orchestrator + REAL GramMintBroadcaster against a fake TON chain.
// Run: node tools/gram-proposer-fallback-spike.cjs
const assert = require("node:assert");
const { canonicalPegIn, pegInFeePolicyFor } = require("@gateway/common");
const { Orchestrator } = require("../packages/coordinator/dist/orchestrator.js");
const { GramMintBroadcaster } = require("../packages/coordinator/dist/adapters.js");

const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
  minVizPerTon: 100, maxVizPerTon: 20000, refundFeeMilliViz: 5000n,
};

// Fake GramHttpChain: enough surface for buildProposal + broadcast to run offline.
const fakeChain = () => ({
  isDestinationProvisioned: async () => true,
  orderHashFor: () => "deadbeef",
  nextOrderAddress: async () => ({ orderAddr: "EQorder", seqno: "7" }),
  orderExecuted: async () => true, // let broadcast() confirm the moment threshold is met
});
const fakeStore = () => ({ get: async () => undefined, setStatus: async () => {} });

// A signer that OPENS/APPROVES the order (models an operator that can transact on TON).
const okSigner = (operatorId, contacted) => ({
  operatorId,
  approve: async (action) => {
    contacted.push(operatorId);
    return { actionId: action.id, operatorId, signature: `ton:EQorder:0:approve` };
  },
});
// A signer that FAILS its turn (offline / unfunded wallet / cannot open the order).
const brokenSigner = (operatorId, contacted, reason) => ({
  operatorId,
  approve: async () => {
    contacted.push(`${operatorId}(FAIL)`);
    throw new Error(`signer ${operatorId}: ${reason}`);
  },
});

const action = canonicalPegIn({
  trxId: "1383712ad91270b46641c78412ac66c9a7f6b7c8",
  opIndex: 0,
  remoteChain: "GRAM",
  remoteDestination: "UQDCB9cdnWdWYYK8cgZDRjtuRQjxAqu8NubXBIcI2vMzHynx",
  amountMilliViz: 1500000n,
});

(async () => {
  const OPERATORS = ["op-1", "op-2", "op-3"];

  // A. FAILOVER: the first-contacted operator can't open the order (offline/unfunded);
  //    the coordinator falls through and the remaining two complete the mint. This is the
  //    exact fix for the incident — a broken FIRST operator no longer deadlocks the mint.
  {
    const contacted = [];
    const signers = [
      brokenSigner("op-1", contacted, "cannot open order (offline)"),
      okSigner("op-2", contacted),
      okSigner("op-3", contacted),
    ];
    const r = await new Orchestrator(2, OPERATORS, signers, new GramMintBroadcaster(fakeChain(), () => Promise.resolve(pegInFeePolicyFor(FEES, "GRAM")), fakeStore())).process(action);
    assert.strictEqual(r.broadcast, true, "mint completes via op-2 + op-3 despite op-1 failing first");
    assert.strictEqual(r.approvals, 2);
    assert.deepStrictEqual(contacted, ["op-1(FAIL)", "op-2", "op-3"], "op-1 failed its turn, coordinator failed over");
    console.log("[failover]      broken first opener (op-1) skipped; op-2+op-3 mint -> broadcast=true OK");
  }

  // B. OPERATIONAL FLOOR (honest): with op-1 offline AND op-2 unable to transact on TON,
  //    only op-3 can act. Threshold 2 is unreachable -> the mint cannot complete. Failover
  //    does NOT manufacture a second functional signer; this refunds until one exists.
  {
    const contacted = [];
    const signers = [
      brokenSigner("op-2", contacted, "wallet 0 TON / uninitialized"),
      okSigner("op-3", contacted),
    ];
    const r = await new Orchestrator(2, OPERATORS, signers, new GramMintBroadcaster(fakeChain(), () => Promise.resolve(pegInFeePolicyFor(FEES, "GRAM")), fakeStore())).process(action);
    assert.strictEqual(r.broadcast, false, "one functional signer < threshold 2 -> no mint (would refund)");
    assert.strictEqual(r.approvals, 1);
    console.log("[floor]         only 1 operator can transact (< threshold) -> broadcast=false (refund) OK");
  }

  // C. Happy path: all three live -> threshold met, mint completes (first opens, next approves).
  {
    const contacted = [];
    const signers = OPERATORS.map((id) => okSigner(id, contacted));
    const r = await new Orchestrator(2, OPERATORS, signers, new GramMintBroadcaster(fakeChain(), () => Promise.resolve(pegInFeePolicyFor(FEES, "GRAM")), fakeStore())).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.approvals, 2, "stops at threshold");
    assert.deepStrictEqual(contacted, ["op-1", "op-2"], "contacted in order, stopped once threshold met");
    console.log("[happy]         all live -> first opens, next approves, broadcast=true OK");
  }

  console.log("\nRESULT: the TON opener role fails over across live operators, so a broken FIRST");
  console.log("operator no longer deadlocks the mint. Completing a mint still requires `threshold`");
  console.log("operators that can transact on TON — failover changes WHO opens, not how many.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
