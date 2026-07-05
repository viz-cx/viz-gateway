// LIVE PROOF: the Solana wVIZ mint write-path end-to-end against a real cluster
// (solana-test-validator or devnet). Unlike tools/solana-writepath-spike.cjs
// (offline, no RPC), this exercises the two deferred live steps:
//   1. SolanaChain.buildMintProposal  -> fetches the durable NONCE over live RPC
//      and pins the exact message bytes.
//   2. Each operator KeyedSigner.approveSolanaMint -> validates + partial-signs.
//   3. SolanaChain.submitMint         -> assembles the M partials + submitter,
//      broadcasts, and confirms on-chain.
// Then it reads the recipient's wVIZ ATA balance delta to prove the mint landed.
//
// Source validation (F2) is DISABLED here: this proof targets the Solana write
// path (nonce fetch + broadcast + partial merge), not the F2 re-read (proven
// offline in tools/signer-f2-spike.cjs). A live F2 mint would require re-reading
// a real VIZ deposit, which is out of scope for a Solana-cluster proof.
//
// Env (all required):
//   SOLANA_RPC_URL, SOLANA_WVIZ_MINT, SOLANA_MULTISIG, SOLANA_NONCE_ACCOUNT
//   PROOF_DIR (holds submitter.json, opA.json, opB.json, recipient.json as
//             solana-keygen byte-array files)
//
// Run (after `npm run build`): node tools/solana-devnet-proof.cjs
const assert = require("node:assert");
const fs = require("node:fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const { canonicalPegIn, quotePegIn, pegInFeePolicyFor } = require("@gateway/common");
const { SolanaChain } = require("../packages/solana-watcher/dist/solanaChain.js");
const { KeyedSigner, DISABLED_SOURCE_VALIDATION } = require("../packages/signer/dist/keyedSigner.js");

// Same fee shape the spikes use; the action carries GROSS, the proposal NET.
const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
};

function loadSecret(path) {
  return Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")));
}
function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function ataBalance(conn, mint, owner) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata);
  if (!info) return 0n;
  const bal = await conn.getTokenAccountBalance(ata);
  return BigInt(bal.value.amount);
}

(async () => {
  const rpc = need("SOLANA_RPC_URL");
  const mint = need("SOLANA_WVIZ_MINT");
  const multisig = need("SOLANA_MULTISIG");
  const nonceAccount = need("SOLANA_NONCE_ACCOUNT");
  const dir = need("PROOF_DIR");

  const submitterSecret = loadSecret(`${dir}/submitter.json`);
  const opA = Keypair.fromSecretKey(loadSecret(`${dir}/opA.json`));
  const opB = Keypair.fromSecretKey(loadSecret(`${dir}/opB.json`));
  const recipient = Keypair.fromSecretKey(loadSecret(`${dir}/recipient.json`)).publicKey.toBase58();
  const signers = [opA.publicKey.toBase58(), opB.publicKey.toBase58()].sort();

  const conn = new Connection(rpc, "confirmed");
  const chain = new SolanaChain(rpc, mint, "", 0, { multisig, nonceAccount, submitterSecret });

  // ---- action (a VIZ peg-in tagged for SOLANA) ---------------------------
  const GROSS = 1068237n; // 1068.237 wVIZ gross
  // Unique per run: the action id becomes the on-chain memo, so a stale memo from
  // a prior run must not shadow this run's tx in the mintByActionId lookup.
  const trxId = process.env.PROOF_TRX_ID || `solana-devnet-proof-${Date.now()}`;
  const action = canonicalPegIn({
    trxId,
    opIndex: 0,
    blockNum: 1,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: GROSS,
    remoteChain: "SOLANA",
    remoteDestination: recipient,
  });

  // Recipient ATA does not exist yet -> activation surcharge applies. The mint
  // tx creates the ATA idempotently, so this also exercises the funder path.
  const destProvisioned = await chain.isDestinationProvisioned(recipient);
  const q = quotePegIn(GROSS, destProvisioned, pegInFeePolicyFor(FEES, "SOLANA"));
  assert.ok(q.ok, "expected a valid quote");
  const NET = q.b.net;
  console.log(`[proof] recipient=${recipient} provisioned=${destProvisioned}`);
  console.log(`[proof] GROSS=${GROSS} NET=${NET} fee=${q.b.fee}`);

  // ---- proposer: build the shared proposal (LIVE nonce fetch) ------------
  const proposal = await chain.buildMintProposal(recipient, NET, destProvisioned, signers, action.id);
  console.log(`[proof] nonce fetched: ${proposal.nonceValue} (account ${nonceAccount})`);

  // ---- M operators independently validate + partial-sign -----------------
  const sA = new KeyedSigner("op-1", "", "", FEES, opA.secretKey, DISABLED_SOURCE_VALIDATION);
  const sB = new KeyedSigner("op-2", "", "", FEES, opB.secretKey, DISABLED_SOURCE_VALIDATION);
  const apprA = await sA.approveSolanaMint(action, proposal);
  const apprB = await sB.approveSolanaMint(action, proposal);
  const mintAuth = [apprA.signature, apprB.signature];
  console.log(`[proof] ${mintAuth.length} operator partials collected (2-of-2)`);

  // ---- submitter: assemble + broadcast + confirm -------------------------
  const before = await ataBalance(conn, mint, recipient);
  const sig = await chain.submitMint(proposal, mintAuth);
  console.log(`[proof] mint broadcast + confirmed: ${sig}`);
  const after = await ataBalance(conn, mint, recipient);

  const delta = after - before;
  console.log(`[proof] recipient wVIZ balance: ${before} -> ${after} (delta ${delta})`);
  assert.strictEqual(delta, NET, `expected balance delta ${NET}, got ${delta}`);

  // Idempotency marker: the action id is embedded as a SPL Memo; the coordinator
  // finds it via mintByActionId to detect crash-after-broadcast. submitMint returns
  // at 'confirmed' but mintByActionId scans at 'finalized' (as the coordinator would,
  // later) — poll briefly to let finalization catch up.
  let found = null;
  for (let i = 0; i < 30; i++) {
    found = await chain.mintByActionId(action.id);
    if (found && found.txid === sig) break;
    found = null;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found && found.txid === sig, "mintByActionId must locate the broadcast tx via its memo");
  console.log(`[proof] mintByActionId(${action.id}) -> ${found.txid} OK`);

  console.log(`\nRESULT: live Solana mint round-trip PROVEN. NET=${NET} minted to ${recipient} in tx ${sig}.`);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
