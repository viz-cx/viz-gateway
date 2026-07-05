// SPIKE: the write paths, end-to-end through the real KeyedSigner + adapters.
//   VIZ: two operators independently sign a release proposal; their partial
//        signatures must equal the set produced by one party signing with both
//        keys (=> they merge), and a tampered proposal must be rejected.
//   TON (Phase B): a TON mint approval is an ON-CHAIN effect, not an off-chain
//        signature. This spike proves the signer's glue: it validates net +
//        recipient, computes isProposer from proposerOperatorId, delegates the
//        on-chain effect to the injected TonApprover, and encodes the receipt.
//        The real contract state machine is proven in ton-onchain-approval-spike.
//
// Run: node tools/writepaths-spike.cjs
const assert = require("node:assert");
const { createHash } = require("node:crypto");
const viz = require("viz-js-lib");

const { canonicalPegOut, canonicalPegIn, quotePegIn, pegInFeePolicyFor } = require("@gateway/common");
const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
};
const { milliToViz } = require("../packages/viz-watcher/dist/vizChain.js");
const { buildReleaseTx } = require("../packages/viz-watcher/dist/vizSign.js");
const { KeyedSigner, DISABLED_SOURCE_VALIDATION } = require("../packages/signer/dist/keyedSigner.js");

(async () => {
  // ---- VIZ release path ----------------------------------------------------
  const wifA = viz.auth.toWif("gateway", "pwA", "active");
  const wifB = viz.auth.toWif("gateway", "pwB", "active");

  const action = canonicalPegOut({
    sourceId: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    height: 1,
    from: "EQsender",
    amountMilliViz: 1068237n,
    homeDestination: "alice",
  });
  const proposal = {
    refBlockNum: 1234,
    refBlockPrefix: 5678901,
    expiration: "2026-05-23T12:00:00",
    from: "viz-gateway",
    to: action.recipient, // "alice"
    amount: milliToViz(action.amountMilliViz), // "1068.237 VIZ"
    memo: action.id,
  };

  const opA = new KeyedSigner("op-1", wifA, "", FEES, null, DISABLED_SOURCE_VALIDATION);
  const opB = new KeyedSigner("op-2", wifB, "", FEES, null, DISABLED_SOURCE_VALIDATION);
  const apprA = await opA.signVizRelease(action, proposal);
  const apprB = await opB.signVizRelease(action, proposal);
  const merged = [apprA.signature, apprB.signature];

  const allAtOnce = viz.auth.signTransaction(buildReleaseTx(proposal), [wifA, wifB]).signatures;
  for (const [name, sig] of [["A", apprA.signature], ["B", apprB.signature]]) {
    assert.ok(allAtOnce.includes(sig), `independent VIZ sig ${name} not reproduced by group signing`);
  }
  assert.strictEqual([...merged].sort().join(), [...allAtOnce].sort().join());
  console.log(`[viz] 2 operators signed; partial sigs merge to the group set (${merged.length} sigs) OK`);

  // proposal tampering must be rejected by the signer's validation
  await assert.rejects(opA.signVizRelease(action, { ...proposal, amount: "9999.999 VIZ" }), /amount/);
  await assert.rejects(opA.signVizRelease(action, { ...proposal, to: "mallory" }), /recipient/);
  console.log("[viz] tampered proposals (wrong amount / recipient) REJECTED OK");

  // ---- TON mint approval path (Phase B: on-chain, delegated to TonApprover) ---
  const pegIn = canonicalPegIn({
    trxId: "t1",
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1068237n,
    remoteChain: "GRAM",
    remoteDestination: "EQrecipient_addr",
  });
  const orderHashHex = createHash("sha256").update("mint-order-1").digest("hex");
  // Proposal carries NET (gross − fee); destination provisioned -> no surcharge.
  const qTon = quotePegIn(pegIn.amountMilliViz, true, pegInFeePolicyFor(FEES, "GRAM"));
  assert.ok(qTon.ok, "expected a valid TON quote");
  const mintProposal = {
    orderSeqno: "1",
    orderAddr: "EQorder_addr",
    toAddress: pegIn.recipient, // "EQrecipient_addr"
    amountMilliViz: qTon.b.net.toString(),
    destProvisioned: true,
    orderHashHex,
    actionId: pegIn.id,
    proposerOperatorId: "op-1",
  };

  // Inject a fake on-chain approver: the signer must validate net+recipient, compute
  // isProposer from proposerOperatorId, delegate the effect, and encode the receipt.
  let seenIsProposer = null;
  const fakeApprover = {
    approveMint: async (p, isProposer) => {
      seenIsProposer = isProposer;
      assert.strictEqual(p.orderHashHex, orderHashHex, "approver receives the pinned order hash");
      return { orderAddr: p.orderAddr, myIdx: 0, role: "propose" };
    },
  };
  const opTon = new KeyedSigner("op-1", "", "", FEES, null, DISABLED_SOURCE_VALIDATION, null, fakeApprover);
  const tonAppr = await opTon.approveGramMint(pegIn, mintProposal);
  assert.strictEqual(seenIsProposer, true, "op-1 is the designated proposer");
  assert.ok(tonAppr.signature.startsWith("ton:EQorder_addr:0:propose"), "on-chain receipt encoded into approval");
  assert.strictEqual(tonAppr.operatorId, "op-1");
  console.log("[ton] signer validates + delegates on-chain approval as PROPOSER, encodes receipt OK");

  // a non-proposer operator must compute isProposer=false
  const opTon2 = new KeyedSigner("op-2", "", "", FEES, null, DISABLED_SOURCE_VALIDATION, null, fakeApprover);
  await opTon2.approveGramMint(pegIn, mintProposal);
  assert.strictEqual(seenIsProposer, false, "op-2 is not the designated proposer -> approve, not propose");

  // net mismatch must be rejected BEFORE any on-chain effect
  await assert.rejects(opTon.approveGramMint(pegIn, { ...mintProposal, amountMilliViz: "1" }), /net/);
  // a signer with NO approver configured must refuse (never silently unauthorized)
  const opNoTon = new KeyedSigner("op-1", "", "", FEES, null, DISABLED_SOURCE_VALIDATION);
  await assert.rejects(opNoTon.approveGramMint(pegIn, mintProposal), /approver not configured/);
  console.log("[ton] non-proposer role + net mismatch + missing-approver all handled OK");

  console.log("\nRESULT: VIZ release signing+merge works; TON mint approval delegates the");
  console.log("on-chain effect through the real signer. Order execution is proven in");
  console.log("ton-onchain-approval-spike.cjs against the real vendored contracts.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
