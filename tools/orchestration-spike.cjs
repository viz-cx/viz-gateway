// SPIKE: the solo/federated orchestration end-to-end (offline, real signatures).
// Verifies the coordinator's Orchestrator: build proposal -> collect operator
// approvals up to the threshold -> broadcast. Uses the real KeyedSigner so the
// VIZ partial signatures are genuine; the broadcaster is a fake that records
// what it was handed (no live gateway account needed).
//
// Run: node tools/orchestration-spike.cjs
const assert = require("node:assert");
const viz = require("viz-js-lib");
const { canonicalPegOut } = require("@gateway/common");
const { milliToViz } = require("../packages/viz-watcher/dist/vizChain.js");
const { Orchestrator } = require("../packages/coordinator/dist/orchestrator.js");
const { KeyedSigner } = require("../packages/signer/dist/keyedSigner.js");

const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, TON: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, TON: 1000n },
};

function signerClient(operatorId, wif) {
  const ks = new KeyedSigner(operatorId, wif, "", FEES);
  return { operatorId, approve: (action, proposal) => ks.signVizRelease(action, proposal) };
}

function fakeBroadcaster(action) {
  const proposal = {
    refBlockNum: 1,
    refBlockPrefix: 2,
    expiration: "2026-05-23T12:00:00",
    from: "viz-gateway",
    to: action.recipient,
    amount: milliToViz(action.amountMilliViz),
    memo: action.id,
  };
  const calls = [];
  return {
    calls,
    buildProposal: async () => ({ proposal, feeMilliViz: 0n }),
    broadcast: async (_a, _p, signatures) => {
      calls.push(signatures);
      return "TXID_" + signatures.length;
    },
  };
}

(async () => {
  const action = canonicalPegOut({
    sourceId: "aa".repeat(32),
    height: 1,
    from: "EQx",
    amountMilliViz: 5000n,
    homeDestination: "alice",
  });
  const wifA = viz.auth.toWif("gw", "pA", "active");
  const wifB = viz.auth.toWif("gw", "pB", "active");
  const wifC = viz.auth.toWif("gw", "pC", "active");

  // 1-of-1 (solo bootstrap)
  {
    const b = fakeBroadcaster(action);
    const r = await new Orchestrator(1, ["op-1"], [signerClient("op-1", wifA)], b).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.approvals, 1);
    assert.strictEqual(b.calls[0].length, 1);
    console.log(`[1-of-1] broadcast=true approvals=1 txid=${r.txid} OK`);
  }

  // 2-of-3 (stops collecting once threshold met)
  {
    const b = fakeBroadcaster(action);
    const signers = [
      signerClient("op-1", wifA),
      signerClient("op-2", wifB),
      signerClient("op-3", wifC),
    ];
    const r = await new Orchestrator(2, ["op-1", "op-2", "op-3"], signers, b).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.approvals, 2);
    assert.strictEqual(b.calls[0].length, 2);
    console.log("[2-of-3] broadcast=true approvals=2 (stopped at threshold) OK");
  }

  // under threshold: only 1 signer up, need 2 -> no broadcast
  {
    const b = fakeBroadcaster(action);
    const r = await new Orchestrator(2, ["op-1", "op-2", "op-3"], [signerClient("op-1", wifA)], b).process(action);
    assert.strictEqual(r.broadcast, false);
    assert.strictEqual(r.approvals, 1);
    assert.strictEqual(b.calls.length, 0);
    console.log("[under-threshold] broadcast=false approvals=1 (no broadcast) OK");
  }

  // rogue signer (unknown operator id) is ignored by the ApprovalSet
  {
    const b = fakeBroadcaster(action);
    const rogue = {
      operatorId: "intruder",
      approve: async (a) => ({ actionId: a.id, operatorId: "intruder", signature: "x" }),
    };
    const r = await new Orchestrator(2, ["op-1", "op-2", "op-3"], [rogue, signerClient("op-1", wifA)], b).process(action);
    assert.strictEqual(r.approvals, 1);
    assert.strictEqual(r.broadcast, false);
    console.log("[rogue-signer] unknown operator ignored; approvals=1 broadcast=false OK");
  }

  console.log("\nRESULT: orchestration completes a peg at 1-of-1 and 2-of-3 with real");
  console.log("signatures, stops at threshold, and refuses under-threshold / rogue signers.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
