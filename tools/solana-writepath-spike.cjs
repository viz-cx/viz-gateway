// SPIKE: the Solana wVIZ mint write-path, end-to-end through the real
// KeyedSigner + solanaSign, fully offline (no RPC).
//   - M operators independently approve+sign one durable-nonce mint tx; their
//     partial ed25519 signatures must merge (verifySignatures() == true).
//   - tampered amount/recipient must be rejected by the signer's validation.
//   - partials collected over one amount must fail when the assembled tx mints a
//     different amount.
//
// Run (after `npm run build`): node tools/solana-writepath-spike.cjs
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const { canonicalPegIn, quotePegIn, pegInFeePolicyFor } = require("@gateway/common");
const {
  mintMessageB64,
  buildSignedMintTx,
} = require("../packages/solana-watcher/dist/solanaSign.js");
const { KeyedSigner, DISABLED_SOURCE_VALIDATION } = require("../packages/signer/dist/keyedSigner.js");

// Shared fee config (must match across operators). The action carries GROSS; the
// proposal carries NET = gross - base - activation; the signer re-derives base.
const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
  gramVizPerTon: 500, refundFeeMilliViz: 5000n,
};

(async () => {
  const submitter = Keypair.generate();
  const opA = Keypair.generate();
  const opB = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const multisig = Keypair.generate().publicKey.toBase58();
  const nonceAccount = Keypair.generate().publicKey.toBase58();
  const nonceValue = Keypair.generate().publicKey.toBase58(); // 32-byte base58, blockhash-like
  const recipient = Keypair.generate().publicKey.toBase58();
  const signers = [opA.publicKey.toBase58(), opB.publicKey.toBase58()].sort();

  const GROSS = 1068237n;
  // recipient is the remote destination; canonicalPegIn maps it to action.recipient.
  const pegIn = canonicalPegIn({
    trxId: "t1",
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: GROSS, // GROSS; fee applied at proposal build
    remoteChain: "SOLANA",
    remoteDestination: recipient,
  });

  // Destination already provisioned -> no activation surcharge.
  const q = quotePegIn(GROSS, true, pegInFeePolicyFor(FEES, "SOLANA"));
  assert.ok(q.ok, "expected a valid quote");
  const NET = q.b.net;

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

  const proposal = makeProposal(NET, true);

  const sA = new KeyedSigner("op-1", "", "", FEES, opA.secretKey, DISABLED_SOURCE_VALIDATION);
  const sB = new KeyedSigner("op-2", "", "", FEES, opB.secretKey, DISABLED_SOURCE_VALIDATION);
  const apprA = await sA.approveSolanaMint(pegIn, proposal);
  const apprB = await sB.approveSolanaMint(pegIn, proposal);
  const mintAuth = [apprA.signature, apprB.signature];

  const raw = buildSignedMintTx(proposal, mintAuth, submitter.secretKey);
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0, "expected a serialized signed tx");
  console.log(`[solana] mint NET=${NET} (gross ${GROSS}, fee ${q.b.fee}); ${mintAuth.length} operators merged into one tx (${raw.length} bytes) OK`);

  await assert.rejects(
    sA.approveSolanaMint(pegIn, { ...proposal, recipient: Keypair.generate().publicKey.toBase58() }),
    /recipient/,
  );
  await assert.rejects(
    sA.approveSolanaMint(pegIn, makeProposal(9999999n, true)),
    /net/,
  );
  console.log("[solana] tampered proposals (wrong recipient / net) REJECTED OK");

  const badProposal = makeProposal(NET - 1n, true);
  assert.throws(() => buildSignedMintTx(badProposal, mintAuth, submitter.secretKey), /verification/);
  console.log("[solana] partials over a different amount fail signature verification OK");

  console.log("\nRESULT: Solana mint partial-signing + merge works through the real signer.");
  console.log("Nonce fetch + broadcast need a live devnet mint (deferred; see RUNBOOK).");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
