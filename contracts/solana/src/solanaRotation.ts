import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  AuthorityType,
  createSetAuthorityInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { OperatorRef, SolanaRotationProposal } from "@gateway/common";

/**
 * Solana operator rotation — Phase B (the authority handoff).
 *
 * One durable-nonce transaction moves the wVIZ mint's MintTokens + FreezeAccount
 * authorities from the current SPL multisig to a freshly created one. Every
 * current operator signs byte-identical message bytes so their ed25519 partials
 * merge onto the single transaction (exactly like the mint_to peg-in path). A
 * dedicated rotation nonce keeps the bytes stable for async collection.
 *
 * Phase A (creating the new multisig) is a permissionless on-chain write done in
 * the CLI; only its resulting address is pinned here.
 */

/** Rebuild the EXACT unsigned handoff transaction from a proposal. */
export function buildHandoffTx(p: SolanaRotationProposal): Transaction {
  const submitter = new PublicKey(p.feePayer);
  const oldMs = new PublicKey(p.oldMultisig);
  const newMs = new PublicKey(p.newMultisig);
  const mint = new PublicKey(p.mint);
  const multiSigners = p.signers.map((s) => new PublicKey(s));
  const tx = new Transaction();
  tx.feePayer = submitter;
  tx.recentBlockhash = p.nonceValue;
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey: new PublicKey(p.nonceAccount),
      authorizedPubkey: submitter,
    }),
    createSetAuthorityInstruction(
      mint,
      oldMs,
      AuthorityType.MintTokens,
      newMs,
      multiSigners,
      TOKEN_2022_PROGRAM_ID,
    ),
    createSetAuthorityInstruction(
      mint,
      oldMs,
      AuthorityType.FreezeAccount,
      newMs,
      multiSigners,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return tx;
}

/** The exact message bytes operators sign, base64-encoded. */
export function handoffMessageB64(p: SolanaRotationProposal): string {
  return buildHandoffTx(p).serializeMessage().toString("base64");
}

/**
 * Produce this operator's partial signature, as "<memberPubkeyB58>:<sigHex>".
 * Refuses unless the rebuilt message equals `proposal.messageB64` and this
 * operator is in the current multisig signer set.
 */
export function signHandoff(p: SolanaRotationProposal, secretKey: Uint8Array): string {
  if (handoffMessageB64(p) !== p.messageB64) {
    throw new Error("rebuilt handoff message != proposal.messageB64; refusing to sign");
  }
  const kp = Keypair.fromSecretKey(secretKey);
  const member = kp.publicKey.toBase58();
  if (!p.signers.includes(member)) {
    throw new Error(`signer ${member} is not in the current multisig signer set`);
  }
  const tx = buildHandoffTx(p);
  tx.partialSign(kp);
  const entry = tx.signatures.find((s) => s.publicKey.equals(kp.publicKey));
  if (!entry || !entry.signature) throw new Error("partialSign produced no signature");
  return `${member}:${entry.signature.toString("hex")}`;
}

/**
 * Assemble the broadcast-ready raw transaction: attach the member signatures
 * from `partials`, sign as the submitter (fee payer + nonce authority), and
 * verify ALL signatures. Throws if a member sig is foreign to the signer set or
 * if verification fails. Pure (no network).
 */
export function buildSignedHandoffTx(
  p: SolanaRotationProposal,
  partials: string[],
  submitterSecret: Uint8Array,
): Buffer {
  const tx = buildHandoffTx(p);
  for (const entry of partials) {
    const idx = entry.indexOf(":");
    if (idx < 0) throw new Error(`malformed partial entry: ${entry}`);
    const pk = entry.slice(0, idx);
    const sigHex = entry.slice(idx + 1);
    if (!p.signers.includes(pk)) {
      throw new Error(`partial signer ${pk} not in multisig signer set`);
    }
    tx.addSignature(new PublicKey(pk), Buffer.from(sigHex, "hex"));
  }
  tx.partialSign(Keypair.fromSecretKey(submitterSecret));
  // verifySignatures(false): verify sigs that ARE present without requiring all
  // N multisig slots to be filled (SPL multisig enforces M-of-N on-chain).
  if (!tx.verifySignatures(false)) {
    throw new Error("assembled handoff tx failed signature verification");
  }
  return tx.serialize({ requireAllSignatures: false });
}

/**
 * Trust-critical: a co-signer refuses unless
 *   (a) the rebuilt handoff bytes equal proposal.messageB64,
 *   (b) the on-chain new multisig's members == master.newOperators[].solanaPubkey
 *       (order-independent) and threshold == master.newThreshold,
 *   (c) the proposal chainId matches the master.
 * `onchainNewMultisig` is fetched from chain by the caller (the CLI).
 */
export function validateHandoffProposal(
  p: SolanaRotationProposal,
  master: { chainId: string; newThreshold: number; newOperators: OperatorRef[] },
  onchainNewMultisig: { members: string[]; threshold: number },
): void {
  if (p.version !== 1) throw new Error(`unsupported proposal version ${p.version}`);
  if (p.chainId !== master.chainId) {
    throw new Error(`proposal chainId '${p.chainId}' != expected '${master.chainId}'`);
  }
  if (handoffMessageB64(p) !== p.messageB64) {
    throw new Error("rebuilt handoff bytes != proposal.messageB64 (tampered or stale)");
  }
  const expected = master.newOperators.map((o) => o.solanaPubkey);
  if (expected.some((s) => !s)) {
    throw new Error("master proposal has an operator without a solanaPubkey");
  }
  if (onchainNewMultisig.threshold !== master.newThreshold) {
    throw new Error(
      `new multisig threshold ${onchainNewMultisig.threshold} != expected ${master.newThreshold}`,
    );
  }
  const a = [...expected].sort();
  const b = [...onchainNewMultisig.members].sort();
  if (a.length !== b.length || !a.every((v, i) => v === b[i])) {
    throw new Error("new multisig members do not match the proposal's new operator set");
  }
}
