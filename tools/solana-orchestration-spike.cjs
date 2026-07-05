// SPIKE: a Solana peg-in driven end-to-end through the REAL live-service routing,
// fully offline (no RPC).
//   - parseRemoteTarget maps the "solana:"/"ton:" memo prefix; bare memo rejected.
//   - canonicalPegIn commits the chain into the digest (SOLANA != TON).
//   - routeApproval dispatches PEG_IN by proposal shape to approveSolanaMint.
//   - the real Orchestrator collects M operator approvals at 2-of-2 and a fake
//     SolanaMintBroadcaster assembles the merged tx (buildSignedMintTx verifies).
//   - cross-checks reject a TON-shaped proposal on a SOLANA action and an
//     unrecognized PEG_IN shape.
//
// Run (after `npm run build`): node tools/solana-orchestration-spike.cjs
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const { canonicalPegIn, parseRemoteTarget, quotePegIn, pegInFeePolicyFor } = require("@gateway/common");
const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
};
const {
  mintMessageB64,
  buildSignedMintTx,
} = require("../packages/solana-watcher/dist/solanaSign.js");
const { KeyedSigner, DISABLED_SOURCE_VALIDATION } = require("../packages/signer/dist/keyedSigner.js");
const { routeApproval } = require("../packages/signer/dist/routeApproval.js");
const { Orchestrator } = require("../packages/coordinator/dist/orchestrator.js");

(async () => {
  // ---- memo parsing -------------------------------------------------------
  assert.deepStrictEqual(parseRemoteTarget("solana:9xRecipient"), { chain: "SOLANA", destination: "9xRecipient" });
  assert.deepStrictEqual(parseRemoteTarget("gram:EQabc"), { chain: "GRAM", destination: "EQabc" });
  assert.throws(() => parseRemoteTarget("9xNoPrefix"), /missing chain prefix/);
  assert.throws(() => parseRemoteTarget("doge:9x"), /unknown chain prefix/);
  console.log("[memo] solana:/gram: parsed; bare + unknown-prefix REJECTED OK");

  // ---- key material + proposal --------------------------------------------
  const submitter = Keypair.generate();
  const opA = Keypair.generate();
  const opB = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const multisig = Keypair.generate().publicKey.toBase58();
  const nonceAccount = Keypair.generate().publicKey.toBase58();
  const nonceValue = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const signers = [opA.publicKey.toBase58(), opB.publicKey.toBase58()].sort();

  const target = parseRemoteTarget(`solana:${recipient}`);
  const action = canonicalPegIn({
    trxId: "t1",
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1068237n,
    remoteChain: target.chain,
    remoteDestination: target.destination,
  });
  assert.strictEqual(action.remoteChain, "SOLANA", "action must carry the SOLANA tag");

  // the chain is committed in the digest: a GRAM-targeted twin differs
  const gramTwin = canonicalPegIn({
    trxId: "t1", opIndex: 0, blockNum: 1, from: "viz-user", to: "viz-gateway",
    amountMilliViz: 1068237n, remoteChain: "GRAM", remoteDestination: recipient,
  });
  assert.notStrictEqual(action.digest, gramTwin.digest, "digest must commit to the target chain");
  console.log("[canonical] action tagged SOLANA; chain committed in digest (SOLANA != GRAM) OK");

  const q = quotePegIn(action.amountMilliViz, true, pegInFeePolicyFor(FEES, "SOLANA"));
  assert.ok(q.ok, "expected a valid quote");

  function makeProposal(netMilliViz, destProvisioned = true) {
    const p = {
      recipient,
      amountMilliViz: String(netMilliViz),
      destProvisioned,
      mint,
      multisig,
      signers,
      feePayer: submitter.publicKey.toBase58(),
      nonceAccount,
      nonceValue,
      decimals: 3,
      messageB64: "",
    };
    p.messageB64 = mintMessageB64(p);
    return p;
  }
  const proposal = makeProposal(q.b.net, true);

  // ---- fake broadcaster: build the prebuilt proposal, assemble on broadcast --
  const broadcaster = {
    buildProposal: async () => ({ proposal, feeMilliViz: q.b.fee }),
    broadcast: async (_a, p, signatures) => {
      const raw = buildSignedMintTx(p, signatures, submitter.secretKey);
      assert.ok(Buffer.isBuffer(raw) && raw.length > 0, "merged tx must serialize");
      return `SOLSIG_${signatures.length}`;
    },
    actionExecuted: async () => ({ executed: false }),
  };

  // ---- real signers wrapped by routeApproval (exercises shape routing) -----
  const ksA = new KeyedSigner("op-1", "", "", FEES, opA.secretKey, DISABLED_SOURCE_VALIDATION);
  const ksB = new KeyedSigner("op-2", "", "", FEES, opB.secretKey, DISABLED_SOURCE_VALIDATION);
  const signerClient = (id, ks) => ({ operatorId: id, approve: (a, p) => routeApproval(ks, a, p) });

  const result = await new Orchestrator(
    2,
    ["op-1", "op-2"],
    [signerClient("op-1", ksA), signerClient("op-2", ksB)],
    broadcaster,
  ).process(action);

  assert.strictEqual(result.broadcast, true, "2-of-2 must broadcast");
  assert.strictEqual(result.approvals, 2, "both operators must approve");
  assert.strictEqual(result.txid, "SOLSIG_2");
  console.log("[orchestrate] 2-of-2 Solana peg-in -> routed by shape, merged, broadcast OK");

  // ---- negatives ----------------------------------------------------------
  const tonProposal = { orderSeqno: "1", toAddress: recipient, amountMilliViz: q.b.net.toString(), destProvisioned: true, orderHashHex: action.digest };
  await assert.rejects(routeApproval(ksA, action, tonProposal), /GRAM proposal for a SOLANA action/);
  await assert.rejects(routeApproval(ksA, action, { foo: "bar" }), /shape not recognized/);
  console.log("[orchestrate] TON-shaped proposal on a SOLANA action + unknown shape REJECTED OK");

  // ---- Solana config pinning (PR#11 follow-up #5) -------------------------
  // A signer that pins mint/multisig/nonceAccount to its OWN config rejects a
  // coordinator that swaps any of them for an attacker-controlled account.
  const ksPinned = new KeyedSigner("op-pin", "", "", FEES, opA.secretKey, DISABLED_SOURCE_VALIDATION, {
    mint,
    multisig,
    nonceAccount,
  });
  await ksPinned.approveSolanaMint(action, proposal); // honest proposal matches config -> passes
  for (const field of ["mint", "multisig", "nonceAccount"]) {
    const tampered = { ...proposal, [field]: Keypair.generate().publicKey.toBase58() };
    await assert.rejects(
      ksPinned.approveSolanaMint(action, tampered),
      new RegExp(`proposal\\.${field} .* != signer-configured ${field}`),
      `tampered ${field} must be rejected`,
    );
  }
  console.log("[pin] tampered mint/multisig/nonceAccount REJECTED; honest config accepted OK");

  // ---- feePayer pinning (pre-audit sweep, finding C) ----------------------
  // When the operator configures the expected submitter pubkey, the signer also pins
  // feePayer: a compromised coordinator naming a different (even internally-consistent)
  // fee payer is rejected at validation, not left to fail the on-chain nonce advance.
  const ksFeePin = new KeyedSigner("op-feepin", "", "", FEES, opA.secretKey, DISABLED_SOURCE_VALIDATION, {
    mint,
    multisig,
    nonceAccount,
    feePayer: submitter.publicKey.toBase58(),
  });
  await ksFeePin.approveSolanaMint(action, proposal); // honest feePayer matches config -> passes
  // Swap feePayer to an attacker key AND recompute messageB64 so the proposal is internally
  // consistent — proving the PIN (not the message check) is what rejects it.
  const evilPayer = Keypair.generate().publicKey.toBase58();
  const tamperedPayer = { ...proposal, feePayer: evilPayer };
  tamperedPayer.messageB64 = mintMessageB64(tamperedPayer);
  await assert.rejects(
    ksFeePin.approveSolanaMint(action, tamperedPayer),
    /proposal\.feePayer .* != signer-configured feePayer/,
    "tampered (but self-consistent) feePayer must be rejected by the pin",
  );
  // And when feePayer is NOT pinned (no submitter pubkey configured), the same swap is
  // NOT rejected by the pin layer (on-chain nonce authority is the backstop) -> liveness only.
  await ksPinned.approveSolanaMint(action, tamperedPayer); // ksPinned has no feePayer pin -> passes validation
  console.log("[pin] feePayer pin REJECTS a self-consistent wrong payer; unpinned falls back to on-chain OK");

  console.log("\nRESULT: a Solana peg-in routes end-to-end through the real signer routing");
  console.log("and coordinator orchestration; chain tag committed, partials merge, broadcast.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
