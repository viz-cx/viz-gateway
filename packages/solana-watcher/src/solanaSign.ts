import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { SolanaMintProposal } from "@gateway/common";

/**
 * Solana wVIZ mint signing (the peg-in write path).
 *
 * The mint is one Token-2022 `mint_to` transaction whose authority is an SPL
 * M-of-N multisig. Every operator signs byte-identical message bytes so their
 * ed25519 signatures merge onto the single transaction (like VIZ partials). A
 * durable NONCE replaces the recent blockhash so the bytes never expire until
 * consumed, enabling async signature collection.
 *
 * Two signature roles share the tx:
 *   - operator members -> the M multisig signatures = the mint authorization
 *   - submitter        -> fee payer + nonce authority + ATA funder (added last)
 */

/** Recipient's associated token account for the wVIZ mint (deterministic). */
export function recipientAta(p: SolanaMintProposal): PublicKey {
  return getAssociatedTokenAddressSync(
    new PublicKey(p.mint),
    new PublicKey(p.recipient),
    false, // recipient is a wallet (on-curve)
    TOKEN_2022_PROGRAM_ID,
  );
}

/** SPL Memo program id (v1 address, accepted by all web3.js versions). */
const MEMO_PROGRAM_ID_STR = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

/**
 * Rebuild the EXACT unsigned mint transaction from a proposal.
 *
 * Durable-nonce shape: `recentBlockhash` is set to the stored nonce value and
 * the first instruction is `nonceAdvance` — the runtime treats this as a nonce
 * transaction (the bytes never expire until the nonce is consumed).
 *
 * If `proposal.actionId` is set, a SPL Memo instruction carrying the action id
 * is appended last. This makes the mint idempotent: the coordinator can scan
 * on-chain memos for the action id to detect a crash-after-broadcast case.
 */
export function buildMintTx(p: SolanaMintProposal): Transaction {
  const submitter = new PublicKey(p.feePayer);
  const advance = SystemProgram.nonceAdvance({
    noncePubkey: new PublicKey(p.nonceAccount),
    authorizedPubkey: submitter,
  });
  const tx = new Transaction();
  tx.feePayer = submitter;
  tx.recentBlockhash = p.nonceValue;
  const ata = recipientAta(p);
  const multiSigners = p.signers.map((s) => new PublicKey(s));
  tx.add(
    advance,
    createAssociatedTokenAccountIdempotentInstruction(
      submitter,
      ata,
      new PublicKey(p.recipient),
      new PublicKey(p.mint),
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToInstruction(
      new PublicKey(p.mint),
      ata,
      new PublicKey(p.multisig),
      BigInt(p.amountMilliViz),
      multiSigners,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  if (p.actionId) {
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID_STR), keys: [], data: Buffer.from(p.actionId, "utf-8") }));
  }
  return tx;
}

/** The exact message bytes operators sign, base64-encoded. */
export function mintMessageB64(p: SolanaMintProposal): string {
  return buildMintTx(p).serializeMessage().toString("base64");
}

/**
 * Produce this operator's partial signature, as "<memberPubkeyB58>:<sigHex>".
 * Refuses to sign unless the rebuilt message equals `proposal.messageB64` and
 * this operator is in the proposal's signer set.
 */
export function signMint(p: SolanaMintProposal, secretKey: Uint8Array): string {
  if (mintMessageB64(p) !== p.messageB64) {
    throw new Error("rebuilt mint message != proposal.messageB64; refusing to sign");
  }
  const kp = Keypair.fromSecretKey(secretKey);
  const member = kp.publicKey.toBase58();
  if (!p.signers.includes(member)) {
    throw new Error(`signer ${member} is not in the proposal multisig signer set`);
  }
  const tx = buildMintTx(p);
  tx.partialSign(kp);
  const entry = tx.signatures.find((s) => s.publicKey.equals(kp.publicKey));
  if (!entry || !entry.signature) throw new Error("partialSign produced no signature");
  return `${member}:${entry.signature.toString("hex")}`;
}

/**
 * Assemble the broadcast-ready raw transaction: attach the member signatures
 * from `mintAuth`, sign as the submitter (fee payer + nonce authority), and
 * verify ALL signatures. Throws if a member sig is foreign to the signer set or
 * if verification fails. Pure (no network) — submitMint wraps it with send.
 */
export function buildSignedMintTx(
  p: SolanaMintProposal,
  mintAuth: string[],
  submitterSecret: Uint8Array,
): Buffer {
  const tx = buildMintTx(p);
  for (const entry of mintAuth) {
    const idx = entry.indexOf(":");
    if (idx < 0) throw new Error(`malformed mintAuth entry: ${entry}`);
    const pk = entry.slice(0, idx);
    const sigHex = entry.slice(idx + 1);
    if (!p.signers.includes(pk)) {
      throw new Error(`mintAuth signer ${pk} not in multisig signer set`);
    }
    tx.addSignature(new PublicKey(pk), Buffer.from(sigHex, "hex"));
  }
  tx.partialSign(Keypair.fromSecretKey(submitterSecret));
  if (!tx.verifySignatures()) {
    throw new Error("assembled mint tx failed signature verification");
  }
  return tx.serialize();
}
