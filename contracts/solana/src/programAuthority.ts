import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * H3: the gateway-deposit program is burn-only and permissionless — it CANNOT move deposit tokens
 * anywhere, so burning can't steal. That guarantee holds ONLY while the program is what we audited.
 * Whoever holds the BPF upgrade authority can replace `burn_deposit` with `transfer-everything-to-me`
 * and drain every deposit ATA. So the upgrade authority must be the federation's M-of-N multisig
 * (no single key can upgrade), verified on-chain — and eventually dropped entirely (non-upgradeable).
 *
 * IMPORTANT: the BPF Upgradeable Loader checks a SINGLE authority pubkey; it does not understand
 * SPL Token multisigs (those only gate token-program instructions). "M-of-N" here therefore means a
 * proper on-chain multisig program (e.g. Squads v4) whose authority PDA is set as the upgrade
 * authority — NOT the SPL `createMultisig` account used for the wVIZ mint authority. This module only
 * VERIFIES the on-chain authority equals a configured address and can hand it off to one; standing up
 * the Squads multisig is a separate operator step (see RUNBOOK).
 */

/** The BPF Upgradeable Loader — owns every upgradeable program's ProgramData account. */
export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** UpgradeableLoaderState enum discriminants (bincode: 4-byte u32 LE prefix). */
const STATE_PROGRAM = 2;
const STATE_PROGRAM_DATA = 3;
/** UpgradeableLoaderInstruction::SetAuthority discriminant. */
const IX_SET_AUTHORITY = 4;

/** The ProgramData PDA for an upgradeable program: findPDA([programId], loader). */
export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER_ID)[0];
}

/**
 * Parse a Program account (`programId`'s own account, owned by the loader): a 4-byte enum tag == 2
 * followed by its 32-byte ProgramData address. Throws if the account is not an upgradeable Program
 * (e.g. a plain BPFLoader2 program has no ProgramData and thus no upgrade authority at all).
 */
export function parseProgramAccount(data: Uint8Array): PublicKey {
  if (data.length < 4 + 32) throw new Error(`program account too short (${data.length} bytes) — not an upgradeable program`);
  const tag = readU32LE(data, 0);
  if (tag !== STATE_PROGRAM) {
    throw new Error(`program account enum tag ${tag} != Program(${STATE_PROGRAM}) — not an upgradeable program (BPFLoader2? buffer?)`);
  }
  return new PublicKey(data.slice(4, 4 + 32));
}

/**
 * Parse a ProgramData account: enum tag == 3, u64 slot, Option<Pubkey> upgrade authority.
 * A None authority means the program is IMMUTABLE (non-upgradeable) — the eventual hardened state.
 */
export function parseUpgradeAuthority(data: Uint8Array): { slot: bigint; upgradeAuthority: string | null } {
  if (data.length < 4 + 8 + 1) throw new Error(`programdata account too short (${data.length} bytes)`);
  const tag = readU32LE(data, 0);
  if (tag !== STATE_PROGRAM_DATA) throw new Error(`programdata enum tag ${tag} != ProgramData(${STATE_PROGRAM_DATA})`);
  const slot = readU64LE(data, 4);
  const optionTag = data[12];
  if (optionTag === 0) return { slot, upgradeAuthority: null }; // None → immutable
  if (optionTag !== 1) throw new Error(`programdata Option tag ${optionTag} is neither None(0) nor Some(1)`);
  if (data.length < 13 + 32) throw new Error(`programdata truncated: Some(authority) needs 32 bytes at offset 13`);
  return { slot, upgradeAuthority: new PublicKey(data.slice(13, 13 + 32)).toBase58() };
}

export type AuthorityStatus = "SECURED" | "IMMUTABLE" | "UNSAFE" | "MISCONFIGURED";

/**
 * Fail-closed decision on a program's upgrade authority (pure, so the offline spike asserts the exact
 * verdict the deploy script acts on):
 *   IMMUTABLE     current == null            → non-upgradeable, the hardened end state. ok.
 *   SECURED       current == expected        → held by the federation multisig. ok.
 *   UNSAFE        current is some other key  → a single/foreign key can upgrade & drain. NOT ok;
 *                                              hand off to the multisig (only the current key can sign).
 *   MISCONFIGURED expected empty/blank       → we cannot verify anything. NOT ok.
 * canHandoff is true only for UNSAFE where the current authority is a key the operator controls
 * (the payer) — the loader lets ONLY the current authority reassign it.
 */
export function evaluateUpgradeAuthority(args: {
  current: string | null;
  expectedMultisig: string;
  payer?: string | null;
}): { status: AuthorityStatus; ok: boolean; canHandoff: boolean; reason: string } {
  const expected = args.expectedMultisig.trim();
  if (!expected) {
    return { status: "MISCONFIGURED", ok: false, canHandoff: false, reason: "SOLANA_UPGRADE_MULTISIG not set — cannot verify the upgrade authority" };
  }
  if (args.current === null) {
    return { status: "IMMUTABLE", ok: true, canHandoff: false, reason: "program is non-upgradeable (upgrade authority is None) — the hardened end state" };
  }
  if (args.current === expected) {
    return { status: "SECURED", ok: true, canHandoff: false, reason: `upgrade authority is the federation multisig ${expected}` };
  }
  const canHandoff = !!args.payer && args.current === args.payer;
  return {
    status: "UNSAFE",
    ok: false,
    canHandoff,
    reason:
      `upgrade authority ${args.current} is NOT the federation multisig ${expected} — a single/foreign key can upgrade the ` +
      `program and drain every deposit ATA` + (canHandoff ? " (hand it off: the payer currently holds it)" : " (foreign key: cannot reassign without it)"),
  };
}

/**
 * UpgradeableLoaderInstruction::SetAuthority — reassign a program's upgrade authority to
 * `newAuthority`. Only the CURRENT authority can sign. Data is the bare 4-byte discriminant.
 */
export function buildSetUpgradeAuthorityIx(args: {
  programDataAddress: PublicKey;
  currentAuthority: PublicKey;
  newAuthority: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(IX_SET_AUTHORITY, 0);
  return new TransactionInstruction({
    programId: BPF_UPGRADEABLE_LOADER_ID,
    keys: [
      { pubkey: args.programDataAddress, isSigner: false, isWritable: true },
      { pubkey: args.currentAuthority, isSigner: true, isWritable: false },
      { pubkey: args.newAuthority, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function readU32LE(d: Uint8Array, off: number): number {
  return (d[off]! | (d[off + 1]! << 8) | (d[off + 2]! << 16) | (d[off + 3]! << 24)) >>> 0;
}
function readU64LE(d: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[off + i]!);
  return v;
}
