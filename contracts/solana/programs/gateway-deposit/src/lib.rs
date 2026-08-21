//! Burn-only wVIZ deposit program.
//!
//! Pinocchio (no_std, zero-dependency) rewrite of the original Anchor program.
//! The wire ABI is frozen and byte-identical to the Anchor build — the committed
//! IDL (`target/idl/gateway_deposit.json`) and every off-chain builder
//! (`packages/solana-watcher/src/depositAddress.ts`, tools/*.cjs) work unchanged:
//!
//! - instruction data: `sha256("global:burn_deposit")[..8]` discriminator,
//!   then Borsh `viz_account: String` (u32 LE len + bytes) + `amount: u64` LE;
//! - accounts: `[deposit_authority (PDA), mint (w), deposit_ata (w), token_program]`;
//! - errors keep Anchor's numbering AND check order (parse → account type checks
//!   in field order → constraints in field order → handler), verified by running
//!   the litesvm suite differentially against the last Anchor-built .so
//!   (`GATEWAY_DEPOSIT_SO=<anchor.so> GATEWAY_DEPOSIT_PROGRAM_ID=<its declare_id>
//!   cargo test`).
//!
//! Unlike the Anchor build there is NO `declare_id!`: the PDA is re-derived from
//! the *runtime* program id, so the same .so deploys under any program id and
//! CI no longer patches the source per deploy.
#![no_std]

use pinocchio::Address;

/// First 8 bytes of SHA-256("global:burn_deposit") — Anchor's discriminator.
pub const BURN_DEPOSIT_DISC: [u8; 8] = [34, 175, 58, 161, 153, 178, 166, 59];

/// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (asserted against the SPL
/// interface crate in tests/test_initialize.rs).
pub const TOKEN_2022_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL (asserted in tests).
pub const ATA_PROGRAM_ID: Address = Address::new_from_array([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
]);

/// 11111111111111111111111111111111 — the system program.
pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0u8; 32]);

// Error codes preserved from the Anchor build so observable behavior is identical.
/// `viz_account` over 16 bytes (Anchor custom error base 6000, variant 0 — pinned by tests).
pub const ERR_ACCOUNT_NAME_TOO_LONG: u32 = 6000;
/// Anchor `InstructionFallbackNotFound` — unknown instruction discriminator.
pub const ERR_INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
/// Anchor `InstructionDidNotDeserialize` — malformed Borsh args.
pub const ERR_INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
/// Anchor `ConstraintSeeds` — deposit_authority is not the canonical PDA.
pub const ERR_CONSTRAINT_SEEDS: u32 = 2006;
/// Anchor `ConstraintAssociated` — deposit_ata is not the PDA's ATA.
pub const ERR_CONSTRAINT_ASSOCIATED: u32 = 2009;
/// Anchor `ConstraintTokenOwner` — deposit_ata's owner field is not the PDA.
pub const ERR_CONSTRAINT_TOKEN_OWNER: u32 = 2015;
/// Anchor `AccountNotEnoughKeys` — fewer accounts than the struct declares.
pub const ERR_ACCOUNT_NOT_ENOUGH_KEYS: u32 = 3005;
/// Anchor `AccountOwnedByWrongProgram` — mint/ATA not owned by Token-2022.
pub const ERR_WRONG_OWNER: u32 = 3007;
/// Anchor `InvalidProgramId` — token_program is not Token-2022.
pub const ERR_INVALID_PROGRAM_ID: u32 = 3008;
/// Anchor `AccountNotSystemOwned` — deposit_authority not system-owned.
pub const ERR_NOT_SYSTEM_OWNED: u32 = 3011;
/// Anchor `AccountNotInitialized` — mint/ATA is an empty system-owned account.
pub const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;

// The processor only compiles for the SBF target: `Address::find_program_address`
// is syscall-backed there. Host builds (litesvm tests) load the compiled .so and
// only use the constants above.
#[cfg(target_os = "solana")]
mod processor {
    use super::*;
    use pinocchio::cpi::{invoke_signed, Seed, Signer};
    use pinocchio::error::ProgramError;
    use pinocchio::instruction::{InstructionAccount, InstructionView};
    use pinocchio::{
        no_allocator, nostd_panic_handler, program_entrypoint, AccountView, ProgramResult,
    };

    program_entrypoint!(process_instruction);
    nostd_panic_handler!();
    no_allocator!();

    /// Anchor `InterfaceAccount` type check: an empty system-owned account is
    /// "not initialized" (3012); any other owner than Token-2022 is "owned by
    /// wrong program" (3007).
    fn expect_token_owned(acc: &AccountView) -> Result<(), ProgramError> {
        if acc.owner() == &SYSTEM_PROGRAM_ID && acc.lamports() == 0 {
            return Err(ProgramError::Custom(ERR_ACCOUNT_NOT_INITIALIZED));
        }
        if acc.owner() != &TOKEN_2022_ID {
            return Err(ProgramError::Custom(ERR_WRONG_OWNER));
        }
        Ok(())
    }

    /// Burn `amount` wVIZ from the deposit ATA owned by the PDA derived from
    /// `viz_account`. This is the ONLY instruction: there is no path to transfer
    /// deposit tokens anywhere. Permissionless — burning cannot steal, and the
    /// value handoff (VIZ release) is M-of-N + F2-validated.
    ///
    /// Check order mirrors Anchor exactly (differentially tested): instruction
    /// data → account type checks in `BurnDeposit` field order → constraints in
    /// field order → handler body.
    pub fn process_instruction(
        program_id: &Address,
        accounts: &mut [AccountView],
        data: &[u8],
    ) -> ProgramResult {
        // ── instruction data: disc + Borsh (String, u64) ─────────────────────
        let args = data
            .strip_prefix(&BURN_DEPOSIT_DISC)
            .ok_or(ProgramError::Custom(ERR_INSTRUCTION_FALLBACK_NOT_FOUND))?;
        if args.len() < 4 {
            return Err(ProgramError::Custom(ERR_INSTRUCTION_DID_NOT_DESERIALIZE));
        }
        let name_len = u32::from_le_bytes([args[0], args[1], args[2], args[3]]) as usize;
        let args = &args[4..];
        if args.len() < name_len + 8 {
            return Err(ProgramError::Custom(ERR_INSTRUCTION_DID_NOT_DESERIALIZE));
        }
        let viz_account = &args[..name_len];
        // Anchor's Borsh String rejects invalid UTF-8; keep that behavior.
        if core::str::from_utf8(viz_account).is_err() {
            return Err(ProgramError::Custom(ERR_INSTRUCTION_DID_NOT_DESERIALIZE));
        }
        let amount = u64::from_le_bytes(args[name_len..name_len + 8].try_into().unwrap());

        // ── account type checks, `BurnDeposit` field order ───────────────────
        let [deposit_authority, mint, deposit_ata, token_program, ..] = accounts else {
            return Err(ProgramError::Custom(ERR_ACCOUNT_NOT_ENOUGH_KEYS));
        };

        // deposit_authority is a keyless PDA; it only ever holds lamports.
        if deposit_authority.owner() != &SYSTEM_PROGRAM_ID {
            return Err(ProgramError::Custom(ERR_NOT_SYSTEM_OWNED));
        }
        expect_token_owned(mint)?;
        expect_token_owned(deposit_ata)?;
        if token_program.address() != &TOKEN_2022_ID {
            return Err(ProgramError::Custom(ERR_INVALID_PROGRAM_ID));
        }

        // ── constraints, field order ─────────────────────────────────────────
        // deposit_authority must be the canonical PDA ["deposit", viz_account].
        let (expected_authority, bump) =
            Address::find_program_address(&[b"deposit", viz_account], program_id);
        if deposit_authority.address() != &expected_authority {
            return Err(ProgramError::Custom(ERR_CONSTRAINT_SEEDS));
        }
        // associated_token::authority — the token account's owner field (bytes
        // 32..64 of the SPL account layout) must be the PDA; Anchor checks this
        // before the associated-address derivation.
        {
            let ata_data = deposit_ata.try_borrow()?;
            match ata_data.get(32..64) {
                Some(owner) if owner == deposit_authority.address().as_ref() => {}
                _ => return Err(ProgramError::Custom(ERR_CONSTRAINT_TOKEN_OWNER)),
            }
        }
        // deposit_ata must be exactly the PDA's Token-2022 ATA for this mint.
        let (expected_ata, _) = Address::find_program_address(
            &[
                deposit_authority.address().as_ref(),
                TOKEN_2022_ID.as_ref(),
                mint.address().as_ref(),
            ],
            &ATA_PROGRAM_ID,
        );
        if deposit_ata.address() != &expected_ata {
            return Err(ProgramError::Custom(ERR_CONSTRAINT_ASSOCIATED));
        }

        // ── handler body ─────────────────────────────────────────────────────
        if viz_account.len() > 16 {
            return Err(ProgramError::Custom(ERR_ACCOUNT_NAME_TOO_LONG));
        }

        // ── CPI: Token-2022 Burn { amount } — [ata (w), mint (w), authority (s)]
        let mut ix_data = [0u8; 9];
        ix_data[0] = 8; // TokenInstruction::Burn
        ix_data[1..9].copy_from_slice(&amount.to_le_bytes());
        let ix_accounts = [
            InstructionAccount::writable(deposit_ata.address()),
            InstructionAccount::writable(mint.address()),
            InstructionAccount::readonly_signer(deposit_authority.address()),
        ];
        let instruction = InstructionView {
            program_id: &TOKEN_2022_ID,
            accounts: &ix_accounts,
            data: &ix_data,
        };
        let bump_seed = [bump];
        let seeds = [
            Seed::from(b"deposit".as_ref()),
            Seed::from(viz_account),
            Seed::from(bump_seed.as_ref()),
        ];
        invoke_signed(
            &instruction,
            &[&*deposit_ata, &*mint, &*deposit_authority],
            &[Signer::from(&seeds)],
        )
    }
}
