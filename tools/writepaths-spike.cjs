// SPIKE: the write paths, end-to-end through the real KeyedSigner + adapters.
//   VIZ: two operators independently sign a release proposal; their partial
//        signatures must equal the set produced by one party signing with both
//        keys (=> they merge), and a tampered proposal must be rejected.
//   TON: an operator's ed25519 mint approval must verify, and a tampered order
//        hash must fail verification.
//
// Run: node tools/writepaths-spike.cjs
const assert = require("node:assert");
const { createHash } = require("node:crypto");
const viz = require("viz-js-lib");

const { canonicalPegOut, canonicalPegIn } = require("@gateway/common");
const { milliToViz } = require("../packages/viz-watcher/dist/vizChain.js");
const { buildReleaseTx } = require("../packages/viz-watcher/dist/vizSign.js");
const { signMintApproval, verifyMintApproval, keyPairFromMnemonic } = require("../packages/ton-watcher/dist/tonSign.js");
const { KeyedSigner } = require("../packages/signer/dist/keyedSigner.js");
const { mnemonicNew } = require("@ton/crypto");

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

  const opA = new KeyedSigner("op-1", wifA, "");
  const opB = new KeyedSigner("op-2", wifB, "");
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

  // ---- TON mint approval path ---------------------------------------------
  const words = await mnemonicNew();
  const mnemonic = words.join(" ");
  const { publicKey } = await keyPairFromMnemonic(mnemonic);

  const pegIn = canonicalPegIn({
    trxId: "t1",
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1068237n,
    tonDestination: "EQrecipient_addr",
  });
  const orderHashHex = createHash("sha256").update("mint-order-1").digest("hex");
  const mintProposal = {
    orderSeqno: "1",
    toAddress: pegIn.recipient, // "EQrecipient_addr"
    amountMilliViz: pegIn.amountMilliViz.toString(),
    orderHashHex,
  };

  const opTon = new KeyedSigner("op-1", "", mnemonic);
  const tonAppr = await opTon.approveTonMint(pegIn, mintProposal);
  assert.ok(verifyMintApproval(mintProposal, tonAppr.signature, publicKey), "ed25519 approval failed to verify");
  console.log("[ton] ed25519 mint approval verifies against the operator pubkey OK");

  // tampered order hash must fail verification
  const tampered = { ...mintProposal, orderHashHex: createHash("sha256").update("mint-order-2").digest("hex") };
  assert.strictEqual(verifyMintApproval(tampered, tonAppr.signature, publicKey), false);
  // amount mismatch must be rejected by the signer
  await assert.rejects(opTon.approveTonMint(pegIn, { ...mintProposal, amountMilliViz: "1" }), /amount/);
  console.log("[ton] tampered order hash fails verify; amount mismatch REJECTED OK");

  console.log("\nRESULT: VIZ release signing+merge and TON mint approval signing both work");
  console.log("through the real signer. Broadcast/order-execution need live contracts.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
