import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AuthorityType,
  MULTISIG_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
import { createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";

/**
 * The wVIZ mint's on-mint metadata has two authorities, both set to the deploy payer at deploy time
 * (deployMint.ts): the MetadataPointer authority (can re-point where metadata lives) and the
 * token-metadata updateAuthority (can rewrite name/symbol/uri). Either one is full control over what
 * wallets display for wVIZ, so both must leave the single deploy-payer key.
 *
 * IMPORTANT: like the BPF loader (see programAuthority.ts), the token-metadata interface checks a
 * SINGLE signer — Token-2022's `check_update_authority` requires `update_authority_info.is_signer`
 * and has no SPL-multisig path (unlike SetAuthority/MintTo, which accept multisig + remaining
 * signers). An SPL Token multisig account can never be `is_signer`, so handing updateAuthority to
 * one FREEZES metadata forever. The target must be a real signing key or a PDA that signs via CPI
 * (e.g. the Squads v4 vault PDA that also takes the program upgrade authority) — never the SPL
 * `createMultisig` account that gates mint/freeze.
 */

export interface MetadataAuthorityState {
  updateAuthority: string | null; // token-metadata updateAuthority (null = frozen)
  pointerAuthority: string | null; // MetadataPointer extension authority (null = frozen)
}

export type MetadataAuthorityStatus = "SECURED" | "IMMUTABLE" | "UNSAFE" | "MISCONFIGURED";

/**
 * Fail-closed verdict on the metadata authorities (pure, so the offline spike asserts the exact
 * decision the enforce script acts on):
 *   IMMUTABLE     both null                   → nobody can ever touch metadata again. Terminal;
 *                                               acceptable hardened state, though not the plan target.
 *   SECURED       every non-null field == expected → held by the federation authority. ok.
 *   UNSAFE        any field is some other key → a single/foreign key controls what wallets display.
 *   MISCONFIGURED expected empty/blank        → cannot verify anything. NOT ok.
 * canHandoff is true only for UNSAFE where EVERY unsafe field is held by the payer — the
 * token-metadata interface lets only the current authority reassign itself.
 */
export function evaluateMetadataAuthority(args: {
  state: MetadataAuthorityState;
  expected: string;
  payer?: string | null;
}): { status: MetadataAuthorityStatus; ok: boolean; canHandoff: boolean; reason: string } {
  const expected = args.expected.trim();
  if (!expected) {
    return { status: "MISCONFIGURED", ok: false, canHandoff: false, reason: "SOLANA_METADATA_AUTHORITY not set — cannot verify the metadata authorities" };
  }
  const { updateAuthority, pointerAuthority } = args.state;
  if (updateAuthority === null && pointerAuthority === null) {
    return { status: "IMMUTABLE", ok: true, canHandoff: false, reason: "both metadata authorities are None — metadata is frozen forever (terminal)" };
  }
  const unsafe = [
    ["updateAuthority", updateAuthority] as const,
    ["metadataPointer", pointerAuthority] as const,
  ].filter(([, v]) => v !== null && v !== expected);
  if (unsafe.length === 0) {
    return { status: "SECURED", ok: true, canHandoff: false, reason: `metadata authorities are the federation authority ${expected}` };
  }
  const canHandoff = !!args.payer && unsafe.every(([, v]) => v === args.payer);
  return {
    status: "UNSAFE",
    ok: false,
    canHandoff,
    reason:
      unsafe.map(([k, v]) => `${k} ${v}`).join(", ") +
      ` is NOT the federation authority ${expected} — a single/foreign key controls the wVIZ metadata` +
      (canHandoff ? " (hand it off: the payer currently holds it)" : " (foreign key: cannot reassign without it)"),
  };
}

/**
 * The hand-off target must never be an SPL Token multisig account: token-metadata instructions
 * require the authority itself to be `is_signer`, which a multisig account cannot satisfy — the
 * hand-off would succeed and permanently brick metadata updates. Detect by owner + exact size
 * (Multisig is a fixed 355-byte account under either token program).
 */
export function isSplTokenMultisigAccount(ownerBase58: string, dataLength: number): boolean {
  return (
    dataLength === MULTISIG_SIZE &&
    (ownerBase58 === TOKEN_PROGRAM_ID.toBase58() || ownerBase58 === TOKEN_2022_PROGRAM_ID.toBase58())
  );
}

/**
 * The instructions that move every not-yet-secured authority to `newAuthority`, each signed by that
 * field's CURRENT holder (per the state, not an assumed payer — so a dry run can build + simulate
 * them without any secret). Empty when there is nothing to move.
 */
export function buildMetadataHandoffIxs(args: {
  mint: PublicKey;
  state: MetadataAuthorityState;
  newAuthority: PublicKey;
}): TransactionInstruction[] {
  const target = args.newAuthority.toBase58();
  const ixs: TransactionInstruction[] = [];
  const { updateAuthority, pointerAuthority } = args.state;
  if (pointerAuthority !== null && pointerAuthority !== target) {
    ixs.push(
      createSetAuthorityInstruction(
        args.mint,
        new PublicKey(pointerAuthority),
        AuthorityType.MetadataPointer,
        args.newAuthority,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (updateAuthority !== null && updateAuthority !== target) {
    ixs.push(
      createUpdateAuthorityInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: args.mint, // on-mint metadata: metadataAddress == mint
        oldAuthority: new PublicKey(updateAuthority),
        newAuthority: args.newAuthority,
      }),
    );
  }
  return ixs;
}
