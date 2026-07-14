import { mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import type { KeyPair } from "@ton/crypto";

/** The deployer wallet flavours we support (both expose getSeqno/sendTransfer). */
export type DeployerWallet = WalletContractV4 | WalletContractV5R1;

/**
 * Derive the deployer wallet from a 24-word TON mnemonic.
 *
 * Version selected via DEPLOYER_WALLET_VERSION: "v4" (default) or "v5r1"/"v5"
 * (the modern W5 wallet used by Tonkeeper et al.). The multisig address does NOT
 * depend on who deploys — this only needs to match whatever wallet you funded,
 * so the funded wallet's flavour must equal this setting or the derived address
 * (and thus the signer) won't be the funded one.
 */
export async function deriveDeployer(
  mnemonic: string,
  version: string = process.env.DEPLOYER_WALLET_VERSION ?? "v4",
): Promise<{ keyPair: KeyPair; wallet: DeployerWallet }> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24)
    throw new Error(`DEPLOYER_MNEMONIC must be 24 words, got ${words.length}`);
  if (!(await mnemonicValidate(words)))
    throw new Error("DEPLOYER_MNEMONIC failed TON mnemonic validation (wrong/incomplete words?)");
  const keyPair = await mnemonicToPrivateKey(words);
  const v = version.trim().toLowerCase();
  const wallet =
    v === "v5r1" || v === "v5"
      ? WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey })
      : WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return { keyPair, wallet };
}
