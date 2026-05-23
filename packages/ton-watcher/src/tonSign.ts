import { mnemonicToPrivateKey, sign, signVerify } from "@ton/crypto";
import type { TonMintProposal } from "@gateway/common";

/**
 * TON mint approval signing (the peg-in write path, operator side).
 *
 * In multisig-v2 a signer approves an *order* by ed25519-signing the order's
 * cell hash. The proposer builds the order via the official wrapper and shares
 * its 32-byte hash as `orderHashHex`; each operator validates the order's
 * parameters (recipient, amount) against the canonical action, then signs the
 * hash with its ed25519 secret key. Assembling and executing the order on-chain
 * once T approvals exist is wrapper-dependent (see TonHttpChain.submitMintOrder).
 */

export function signMintApproval(p: TonMintProposal, secretKey: Buffer): string {
  const hash = Buffer.from(p.orderHashHex, "hex");
  if (hash.length !== 32) throw new Error("orderHashHex must be a 32-byte order hash (hex)");
  return sign(hash, secretKey).toString("hex");
}

export function verifyMintApproval(
  p: TonMintProposal,
  signatureHex: string,
  publicKey: Buffer,
): boolean {
  return signVerify(
    Buffer.from(p.orderHashHex, "hex"),
    Buffer.from(signatureHex, "hex"),
    publicKey,
  );
}

/** Derive an operator's ed25519 keypair from its mnemonic. */
export async function keyPairFromMnemonic(mnemonic: string): Promise<{ publicKey: Buffer; secretKey: Buffer }> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length < 12) throw new Error("TON signer mnemonic looks too short (expected 24 words)");
  return mnemonicToPrivateKey(words);
}
