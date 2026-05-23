import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import type { KeyPair } from "@ton/crypto";

/** Derive the deployer wallet (WalletContractV4) from a 24-word mnemonic. */
export async function deriveDeployer(
  mnemonic: string,
): Promise<{ keyPair: KeyPair; wallet: WalletContractV4 }> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length < 12) throw new Error("DEPLOYER_MNEMONIC looks too short (expected 24 words)");
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return { keyPair, wallet };
}
