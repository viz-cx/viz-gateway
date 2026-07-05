import { mnemonicToPrivateKey } from "@ton/crypto";

/**
 * TON operator key derivation.
 *
 * Phase B: TON mint approvals are ON-CHAIN effects (multisig-v2 `new_order` /
 * `approve` sent from the operator's own wallet — see tonApprove.ts), NOT
 * off-chain ed25519 signatures. The former sign-the-order-hash approach is
 * retired; all that remains here is deriving the operator's wallet keypair from
 * its mnemonic, used by GramApprover to send those on-chain messages.
 */

/** Derive an operator's ed25519 keypair from its mnemonic. */
export async function keyPairFromMnemonic(mnemonic: string): Promise<{ publicKey: Buffer; secretKey: Buffer }> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length < 12) throw new Error("TON signer mnemonic looks too short (expected 24 words)");
  return mnemonicToPrivateKey(words);
}
