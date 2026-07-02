import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import idlJson from "../../../contracts/solana/target/idl/gateway_deposit.json";

/**
 * PDA-based deposit addresses for Solana peg-out.
 *
 * Each VIZ account maps to a PROGRAM-DERIVED ADDRESS:
 *   PDA(["deposit", vizAccount], programId)
 *
 * There is NO private key anywhere — funds arriving at the PDA are burned by the
 * burn-only gateway program. F2 verification is a pure PDA re-derivation with no secret:
 * every signer independently re-derives `depositAddress(programId, vizAccount)` and asserts
 * it equals the burn source address.
 */

const DEPOSIT_SEED = Buffer.from("deposit");
const pdaCoder = new BorshInstructionCoder(idlJson as unknown as Idl);

/** Derive the PDA PublicKey for a VIZ account under the given gateway program. */
export function depositPubkey(programId: string, vizAccount: string): PublicKey {
  if (!vizAccount) throw new Error("vizAccount required");
  const [pda] = PublicKey.findProgramAddressSync(
    [DEPOSIT_SEED, Buffer.from(vizAccount, "utf8")],
    new PublicKey(programId),
  );
  return pda;
}

/** Base58 PDA deposit address for a VIZ account. */
export function depositAddress(programId: string, vizAccount: string): string {
  return depositPubkey(programId, vizAccount).toBase58();
}

/**
 * The wVIZ ATA of the PDA deposit address (what the scanner watches).
 */
export function depositAta(programId: string, vizAccount: string, mint: string): string {
  const owner = depositPubkey(programId, vizAccount);
  return getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, TOKEN_2022_PROGRAM_ID).toBase58();
}

/**
 * Build the burn_deposit instruction for the gateway program.
 * The instruction encodes the VIZ account name and amount, and references
 * the PDA authority and its ATA.
 */
export function buildBurnDepositIx(args: {
  programId: string;
  vizAccount: string;
  amount: bigint;
  mint: string;
}): TransactionInstruction {
  const programId = new PublicKey(args.programId);
  const authority = depositPubkey(args.programId, args.vizAccount);
  const ata = new PublicKey(depositAta(args.programId, args.vizAccount, args.mint));
  const data = pdaCoder.encode("burn_deposit", {
    viz_account: args.vizAccount,
    amount: new BN(args.amount.toString()),
  });
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.mint), isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
