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
const { canonicalPegIn } = require("@gateway/common");
const {
  mintMessageB64,
  buildSignedMintTx,
} = require("../packages/solana-watcher/dist/solanaSign.js");
const { KeyedSigner } = require("../packages/signer/dist/keyedSigner.js");

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

  // recipient is the remote destination; canonicalPegIn maps it to action.recipient.
  const pegIn = canonicalPegIn({
    trxId: "t1",
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1068237n,
    remoteChain: "SOLANA",
    remoteDestination: recipient,
  });

  function makeProposal(amountMilliViz) {
    const p = {
      recipient,
      amountMilliViz: String(amountMilliViz),
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

  const proposal = makeProposal(1068237n);

  const sA = new KeyedSigner("op-1", "", "", opA.secretKey);
  const sB = new KeyedSigner("op-2", "", "", opB.secretKey);
  const apprA = await sA.approveSolanaMint(pegIn, proposal);
  const apprB = await sB.approveSolanaMint(pegIn, proposal);
  const mintAuth = [apprA.signature, apprB.signature];

  const raw = buildSignedMintTx(proposal, mintAuth, submitter.secretKey);
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0, "expected a serialized signed tx");
  console.log(`[solana] ${mintAuth.length} operators signed; partials merge into one valid tx (${raw.length} bytes) OK`);

  await assert.rejects(
    sA.approveSolanaMint(pegIn, { ...proposal, recipient: Keypair.generate().publicKey.toBase58() }),
    /recipient/,
  );
  await assert.rejects(
    sA.approveSolanaMint(pegIn, { ...proposal, amountMilliViz: "9999999" }),
    /amount/,
  );
  console.log("[solana] tampered proposals (wrong recipient / amount) REJECTED OK");

  const badProposal = makeProposal(9999999n);
  assert.throws(() => buildSignedMintTx(badProposal, mintAuth, submitter.secretKey), /verification/);
  console.log("[solana] partials over a different amount fail signature verification OK");

  console.log("\nRESULT: Solana mint partial-signing + merge works through the real signer.");
  console.log("Nonce fetch + broadcast need a live devnet mint (deferred; see RUNBOOK).");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
