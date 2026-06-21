import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMultisig,
  ExtensionType,
  getMintLen,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { loadSolanaDeployConfig } from "./config";

/**
 * Deploy the wVIZ SPL Token-2022 mint (3 decimals) with the on-mint metadata
 * extension, and an SPL M-of-N multisig as its mint + freeze authority.
 *
 * Dry-run by default (prints the mint + multisig addresses and the metadata,
 * no network writes). Set DEPLOY_SEND=1 with SOLANA_PAYER_SECRET (+ a funded
 * devnet payer) to broadcast. Construction is verified offline
 * (contracts/solana/tools/verify-offline.cjs); validate the live deploy on devnet.
 */
async function main(): Promise<void> {
  const cfg = loadSolanaDeployConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");

  const mint = Keypair.generate();
  const multisig = Keypair.generate(); // deterministic address to print in dry-run

  const metadata: TokenMetadata = {
    mint: mint.publicKey,
    name: cfg.name,
    symbol: cfg.symbol,
    uri: cfg.uri,
    additionalMetadata: [
      ["home_chain", "VIZ"],
      ["backing", "1:1 VIZ locked"],
    ],
  };

  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  console.log(`[deploy:solana] rpc: ${cfg.rpcUrl}`);
  console.log(`[deploy:solana] mint: ${mint.publicKey.toBase58()}  (Token-2022, ${cfg.decimals} decimals)`);
  console.log(`[deploy:solana] multisig (mint+freeze authority): ${multisig.publicKey.toBase58()}  ${cfg.threshold}-of-${cfg.signers.length}`);
  console.log(`[deploy:solana] metadata: ${cfg.symbol} "${cfg.name}" uri=${cfg.uri}`);
  console.log(`[deploy:solana] rent (mint+metadata): ${lamports} lamports`);

  if (!cfg.apply) {
    console.log("\n[deploy:solana] DRY-RUN. Set DEPLOY_SEND=1 + SOLANA_PAYER_SECRET (funded) to broadcast.");
    return;
  }
  if (!cfg.payer) throw new Error("SOLANA_PAYER_SECRET required to APPLY.");
  if (cfg.signers.length === 0) throw new Error("SOLANA_SIGNERS required to APPLY.");

  // 1) Create the SPL multisig (mint + freeze authority).
  const multisigAddr = await createMultisig(
    conn,
    cfg.payer,
    cfg.signers,
    cfg.threshold,
    multisig,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  // 2) Create the Token-2022 mint with metadata pointer + on-mint metadata,
  //    authorities = the multisig.
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: cfg.payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      cfg.payer.publicKey, // metadata-pointer authority (set to multisig/DAO later)
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      cfg.decimals,
      multisigAddr, // mint authority
      multisigAddr, // freeze authority
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint: mint.publicKey,
      metadata: mint.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      mintAuthority: multisigAddr,
      updateAuthority: cfg.payer.publicKey,
    }),
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [cfg.payer, mint]);
  console.log(`[deploy:solana] mint created: ${mint.publicKey.toBase58()} (tx ${sig})`);
  console.log(`[deploy:solana] multisig: ${multisigAddr.toBase58()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
