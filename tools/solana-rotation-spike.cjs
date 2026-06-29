// SPIKE/TEST: Solana rotation core — durable-nonce setAuthority handoff bytes,
// offline partial collection (M current members merge), trust-critical
// validation vs the master proposal + on-chain new multisig, tamper rejection.
// Pure/offline (no RPC).
//
// Run (after `npm run build`): node tools/solana-rotation-spike.cjs
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const {
  buildHandoffTx,
  handoffMessageB64,
  signHandoff,
  buildSignedHandoffTx,
  validateHandoffProposal,
} = require("../contracts/solana/dist/solanaRotation.js");

// Current 2-of-3 operators (the signing authority for the handoff).
const opA = Keypair.generate();
const opB = Keypair.generate();
const opC = Keypair.generate();
const submitter = Keypair.generate();
const mint = Keypair.generate().publicKey.toBase58();
const oldMultisig = Keypair.generate().publicKey.toBase58();
const newMultisig = Keypair.generate().publicKey.toBase58();
const nonceAccount = Keypair.generate().publicKey.toBase58();
const nonceValue = Keypair.generate().publicKey.toBase58(); // 32-byte base58, blockhash-like

const currentMembers = [opA, opB, opC].map((k) => k.publicKey.toBase58()).sort();

function makeProposal() {
  const base = {
    version: 1,
    chainId: "viz-gateway",
    oldMultisig,
    newMultisig,
    mint,
    nonceAccount,
    nonceValue,
    feePayer: submitter.publicKey.toBase58(),
    signers: currentMembers,
    messageB64: "",
    signatures: [],
  };
  base.messageB64 = handoffMessageB64(base);
  return base;
}

// New operator set (what the new multisig should contain). Solana pubkeys only matter here.
const newOps = [
  { id: "op-1", vizPubkey: "V1", tonPubkey: "T1", solanaPubkey: Keypair.generate().publicKey.toBase58() },
  { id: "op-2", vizPubkey: "V2", tonPubkey: "T2", solanaPubkey: Keypair.generate().publicKey.toBase58() },
  { id: "op-3", vizPubkey: "V3", tonPubkey: "T3", solanaPubkey: Keypair.generate().publicKey.toBase58() },
];
const master = { chainId: "viz-gateway", newThreshold: 2, newOperators: newOps };
const onchainNewMultisig = {
  members: newOps.map((o) => o.solanaPubkey),
  threshold: 2,
};

// --- bytes are deterministic ---
const p = makeProposal();
assert.strictEqual(handoffMessageB64(p), p.messageB64, "message bytes must be stable");

// --- M current members produce partials that merge + verify ---
const sigA = signHandoff(p, opA.secretKey);
const sigB = signHandoff(p, opB.secretKey);
assert.ok(sigA.includes(":") && sigB.includes(":"), "partial is pubkey:sigHex");
const raw = buildSignedHandoffTx(p, [sigA, sigB], submitter.secretKey);
assert.ok(Buffer.isBuffer(raw) && raw.length > 0, "assembled handoff serializes");

// --- a non-member cannot sign ---
const outsider = Keypair.generate();
assert.throws(() => signHandoff(p, outsider.secretKey), /not in|member/i);

// --- tampered messageB64 is rejected at sign time ---
const tampered = { ...p, messageB64: handoffMessageB64({ ...p, mint: Keypair.generate().publicKey.toBase58() }) };
assert.throws(() => signHandoff(tampered, opA.secretKey), /refus|!=|mismatch/i);

// --- validateHandoffProposal: happy path ---
validateHandoffProposal(p, master, onchainNewMultisig);

// --- validate rejects wrong threshold on the new multisig ---
assert.throws(
  () => validateHandoffProposal(p, master, { members: onchainNewMultisig.members, threshold: 1 }),
  /threshold/i,
);

// --- validate rejects a new multisig whose members != newOperators ---
assert.throws(
  () => validateHandoffProposal(p, master, { members: [Keypair.generate().publicKey.toBase58(), ...onchainNewMultisig.members.slice(1)], threshold: 2 }),
  /member/i,
);

// --- validate rejects chainId mismatch ---
assert.throws(
  () => validateHandoffProposal({ ...p, chainId: "wrong" }, master, onchainNewMultisig),
  /chainId/i,
);

console.log("\nRESULT: Solana rotation handoff bytes + partial merge + validation/tamper-rejection verified.");
