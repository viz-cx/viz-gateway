/// burn_deposit litesvm integration tests.
///
/// These tests run fully in-process via LiteSVM — no external validator or
/// `solana-test-validator` process is needed.  `cargo test` is the entry point.
///
/// Every branch of `process_instruction` is exercised against the compiled .so:
/// the happy path, both name-length boundaries, each data-parse rejection, each
/// account-validation error (with its pinned Anchor error code), CPI error
/// propagation, and the Anchor compatibility quirks (trailing instruction data
/// and extra accounts are tolerated).
///
/// The same suite doubles as a differential ABI test against the last
/// Anchor-built .so — every expectation below matches observed Anchor behavior:
///
/// ```sh
/// GATEWAY_DEPOSIT_SO=<anchor .so> \
/// GATEWAY_DEPOSIT_PROGRAM_ID=<its declare_id> cargo test
/// ```
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022_interface::{
    instruction::{initialize_account3, initialize_mint2, mint_to},
    state::Account as TokenAccount,
    ID as TOKEN_2022_PROGRAM_ID,
};

// ──── helpers ────────────────────────────────────────────────────────────────

/// Program id the .so is loaded at. `GATEWAY_DEPOSIT_PROGRAM_ID` overrides it so
/// the suite can run differentially against the old Anchor build, which
/// hard-checks its baked-in `declare_id` (the pinocchio build is id-agnostic).
fn gateway_program_id() -> Pubkey {
    match std::env::var("GATEWAY_DEPOSIT_PROGRAM_ID") {
        Ok(s) => s.parse().expect("GATEWAY_DEPOSIT_PROGRAM_ID must be a pubkey"),
        Err(_) => Pubkey::from_str_const("MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1"),
    }
}

/// Discriminator = first 8 bytes of SHA-256("global:burn_deposit")
const BURN_DEPOSIT_DISC: [u8; 8] = [34, 175, 58, 161, 153, 178, 166, 59];

/// Borsh-encode a &str as a length-prefixed string (u32 LE + bytes).
fn borsh_string(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let len = s.len() as u32;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(s.as_bytes());
    out
}

/// Build the `burn_deposit(viz_account, amount)` instruction data.
fn burn_deposit_data(viz_account: &str, amount: u64) -> Vec<u8> {
    let mut data = BURN_DEPOSIT_DISC.to_vec();
    data.extend_from_slice(&borsh_string(viz_account));
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

/// A LiteSVM with the program .so loaded, a funded payer, and a Token-2022 mint
/// (3 decimals, mint authority = payer).
struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();

        // Load the program .so (built by `cargo build-sbf`; path is relative to
        // CARGO_MANIFEST_DIR). `GATEWAY_DEPOSIT_SO` overrides it for differential
        // runs against another build of the same ABI.
        let so_path = match std::env::var("GATEWAY_DEPOSIT_SO") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent() // programs/gateway-deposit  → programs
                .unwrap()
                .parent() // programs → contracts/solana
                .unwrap()
                .join("target/deploy/gateway_deposit.so"),
        };
        let so_bytes = std::fs::read(&so_path)
            .unwrap_or_else(|e| panic!("cannot read {}: {}", so_path.display(), e));
        svm.add_program(gateway_program_id(), &so_bytes).unwrap();

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

        let mut env = Env { svm, payer, mint: Pubkey::default() };
        env.mint = env.new_mint();
        env
    }

    /// Create a fresh Token-2022 mint (mint authority = payer, no freeze
    /// authority, 3 decimals) and return its address.
    fn new_mint(&mut self) -> Pubkey {
        let mint_kp = Keypair::new();
        let mint_rent = self
            .svm
            .minimum_balance_for_rent_exemption(spl_token_2022_interface::state::Mint::LEN);
        let create_mint_acc_ix = solana_system_interface::instruction::create_account(
            &self.payer.pubkey(),
            &mint_kp.pubkey(),
            mint_rent,
            spl_token_2022_interface::state::Mint::LEN as u64,
            &TOKEN_2022_PROGRAM_ID,
        );
        let init_mint_ix = initialize_mint2(
            &TOKEN_2022_PROGRAM_ID,
            &mint_kp.pubkey(),
            &self.payer.pubkey(),
            None,
            3,
        )
        .unwrap();
        let bh = self.svm.latest_blockhash();
        self.svm
            .send_transaction(Transaction::new_signed_with_payer(
                &[create_mint_acc_ix, init_mint_ix],
                Some(&self.payer.pubkey()),
                &[&self.payer, &mint_kp],
                bh,
            ))
            .expect("create + init mint");
        mint_kp.pubkey()
    }

    /// Send instructions signed by the payer only.
    fn send(
        &mut self,
        ixs: &[Instruction],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let bh = self.svm.latest_blockhash();
        self.svm.send_transaction(Transaction::new_signed_with_payer(
            ixs,
            Some(&self.payer.pubkey()),
            &[&self.payer],
            bh,
        ))
    }

    /// Derive the deposit PDA + its Token-2022 ATA for `viz_account`.
    fn deposit_addrs(&self, viz_account: &str) -> (Pubkey, Pubkey) {
        let (pda, _bump) = Pubkey::find_program_address(
            &[b"deposit", viz_account.as_bytes()],
            &gateway_program_id(),
        );
        let ata =
            get_associated_token_address_with_program_id(&pda, &self.mint, &TOKEN_2022_PROGRAM_ID);
        (pda, ata)
    }

    /// Create the ATA for `owner` and return its address.
    fn create_ata(&mut self, owner: &Pubkey) -> Pubkey {
        let ix = create_associated_token_account_idempotent(
            &self.payer.pubkey(),
            owner,
            &self.mint,
            &TOKEN_2022_PROGRAM_ID,
        );
        self.send(&[ix]).expect("create ATA");
        get_associated_token_address_with_program_id(owner, &self.mint, &TOKEN_2022_PROGRAM_ID)
    }

    /// Mint `amount` tokens to `ata` (mint authority = payer signs).
    fn mint_to(&mut self, ata: &Pubkey, amount: u64) {
        let ix = mint_to(&TOKEN_2022_PROGRAM_ID, &self.mint, ata, &self.payer.pubkey(), &[], amount)
            .unwrap();
        self.send(&[ix]).expect("mint to ATA");
    }

    /// Token balance of `ata`.
    ///
    /// Note: Token-2022 ATAs may have >165 bytes (account-type byte + extension TLV).
    /// `Pack::unpack` checks for exact length, so we use `unpack_from_slice` directly.
    fn balance(&self, ata: &Pubkey) -> u64 {
        let acc = self.svm.get_account(ata).expect("ATA account");
        TokenAccount::unpack_from_slice(&acc.data).expect("unpack token account").amount
    }
}

/// The canonical burn_deposit instruction: `[pda, mint (w), ata (w), token_program]`.
fn burn_ix(pda: &Pubkey, mint: &Pubkey, ata: &Pubkey, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: gateway_program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*pda, false),                  // deposit_authority (PDA)
            AccountMeta::new(*mint, false),                          // mint (writable)
            AccountMeta::new(*ata, false),                           // deposit_ata (writable)
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false), // token_program
        ],
        data,
    }
}

/// Assert the transaction failed and its Debug output contains `needle`
/// (e.g. `"Custom(6000)"` or `"InvalidInstructionData"`).
fn assert_fails_with<T: std::fmt::Debug, E: std::fmt::Debug>(result: Result<T, E>, needle: &str) {
    let err = match result {
        Ok(meta) => panic!("expected failure containing {needle:?}, but tx succeeded: {meta:?}"),
        Err(e) => e,
    };
    let s = format!("{err:?}");
    assert!(s.contains(needle), "expected error containing {needle:?}, got: {s}");
}

// ──── happy path + name-length boundaries ────────────────────────────────────

#[test]
fn burns_exactly_amount_from_deposit_ata() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 1_000);
    assert_eq!(env.balance(&ata), 1_000, "starting balance should be 1000");

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 400));
    let meta = env.send(&[ix]).unwrap_or_else(|e| panic!("burn_deposit failed: {:?}", e));

    assert_eq!(env.balance(&ata), 600, "balance after burn should be 600");
    // Compute ceiling: the Anchor build sat well under this too, so a pass on
    // both builds pins "no CU regression" (run with --nocapture to see the number).
    println!("burn_deposit consumed {} CU", meta.compute_units_consumed);
    assert!(
        meta.compute_units_consumed < 50_000,
        "burn_deposit CU regression: {}",
        meta.compute_units_consumed
    );
}

#[test]
fn accepts_viz_account_of_exactly_16_bytes() {
    let mut env = Env::new();
    let viz_account = "abcdefgh12345678"; // the 16-byte Graphene limit, inclusive
    assert_eq!(viz_account.len(), 16, "fixture must be exactly 16 bytes");
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 50);

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 50));
    env.send(&[ix]).unwrap_or_else(|e| panic!("16-byte name must be accepted: {:?}", e));
    assert_eq!(env.balance(&ata), 0);
}

#[test]
fn rejects_viz_account_longer_than_16_bytes() {
    let mut env = Env::new();
    // 17-byte account name (one byte over the 16-byte Graphene limit).
    let long_account = "twelve345678nine0";
    assert_eq!(long_account.len(), 17, "fixture must be exactly 17 bytes");
    let (pda, _) = env.deposit_addrs(long_account);
    // Create the ATA so the accounts exist — the guard fires before the burn CPI.
    let ata = env.create_ata(&pda);

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(long_account, 1));
    // Anchor custom errors are base 6000; AccountNameTooLong is variant 0 → error code 6000.
    assert_fails_with(env.send(&[ix]), "Custom(6000)");
}

// ──── instruction-data parsing ───────────────────────────────────────────────

#[test]
fn rejects_unknown_discriminator() {
    let mut env = Env::new();
    let (pda, ata) = env.deposit_addrs("alice");

    let mut data = vec![0u8; 8]; // wrong discriminator
    data.extend_from_slice(&borsh_string("alice"));
    data.extend_from_slice(&1u64.to_le_bytes());
    let ix = burn_ix(&pda, &env.mint.clone(), &ata, data);
    // Anchor InstructionFallbackNotFound.
    assert_fails_with(env.send(&[ix]), "Custom(101)");
}

#[test]
fn rejects_truncated_instruction_data() {
    let mut env = Env::new();
    let (pda, ata) = env.deposit_addrs("alice");
    let mint = env.mint;

    // Each case is one way the Borsh (String, u64) payload can come up short.
    let disc = BURN_DEPOSIT_DISC.to_vec();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("no args at all", disc.clone()),
        ("length prefix cut short", [disc.clone(), vec![5, 0, 0]].concat()),
        ("name shorter than its length prefix", {
            let mut d = disc.clone();
            d.extend_from_slice(&10u32.to_le_bytes());
            d.extend_from_slice(b"alice"); // 5 bytes, claims 10, and no amount
            d
        }),
        ("amount missing after the name", [disc.clone(), borsh_string("alice")].concat()),
        ("length prefix larger than the buffer", {
            let mut d = disc.clone();
            d.extend_from_slice(&u32::MAX.to_le_bytes());
            d
        }),
    ];
    for (label, data) in cases {
        let ix = burn_ix(&pda, &mint, &ata, data);
        let result = env.send(&[ix]);
        // Anchor InstructionDidNotDeserialize — except the absurd length prefix,
        // where Anchor OOM-panics allocating the String (ProgramFailedToComplete);
        // the pinocchio build fails cleanly with 102 instead. Both reject the tx.
        let s = format!("{:?}", result.as_ref().expect_err(label));
        assert!(
            s.contains("Custom(102)") || s.contains("ProgramFailedToComplete"),
            "case {label:?}: expected Custom(102) (or Anchor's alloc panic), got: {result:?}"
        );
    }
}

#[test]
fn rejects_invalid_utf8_viz_account() {
    let mut env = Env::new();
    let (pda, ata) = env.deposit_addrs("alice");

    // Anchor's Borsh String rejects invalid UTF-8; the rewrite must too.
    let mut data = BURN_DEPOSIT_DISC.to_vec();
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&[0xFF, 0xFE]); // not valid UTF-8
    data.extend_from_slice(&1u64.to_le_bytes());
    let ix = burn_ix(&pda, &env.mint.clone(), &ata, data);
    // Anchor InstructionDidNotDeserialize.
    assert_fails_with(env.send(&[ix]), "Custom(102)");
}

// ──── account validation ─────────────────────────────────────────────────────

#[test]
fn rejects_missing_accounts() {
    let mut env = Env::new();
    // Create the ATA so the missing account is the ONLY fault (Anchor type-checks
    // the first three accounts before noticing token_program is absent).
    let (pda, _) = env.deposit_addrs("alice");
    let ata = env.create_ata(&pda);

    let mut ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data("alice", 1));
    ix.accounts.pop(); // drop token_program → only 3 of 4 accounts
    // Anchor AccountNotEnoughKeys.
    assert_fails_with(env.send(&[ix]), "Custom(3005)");
}

#[test]
fn rejects_wrong_token_program() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 100);

    // Legacy SPL Token in the token_program slot must be rejected.
    let mut ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 1));
    ix.accounts[3] = AccountMeta::new_readonly(spl_token_interface::ID, false);
    // Anchor InvalidProgramId.
    assert_fails_with(env.send(&[ix]), "Custom(3008)");
}

#[test]
fn rejects_non_canonical_deposit_authority() {
    let mut env = Env::new();
    let viz_account = "alice";
    // Create alice's real ATA so the wrong PDA is the ONLY fault (account type
    // checks run before the seeds constraint).
    let (alice_pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&alice_pda);
    // The PDA for a DIFFERENT viz_account: valid PDA, wrong seeds for "alice".
    let (bob_pda, _) = env.deposit_addrs("bob");

    let ix = burn_ix(&bob_pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 1));
    // Anchor ConstraintSeeds.
    assert_fails_with(env.send(&[ix]), "Custom(2006)");
}

#[test]
fn rejects_deposit_authority_not_system_owned() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 100);

    // Force an account at the canonical PDA address owned by another program.
    env.svm
        .set_account(
            pda,
            Account {
                lamports: 1_000_000,
                data: vec![],
                owner: TOKEN_2022_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 1));
    // Anchor AccountNotSystemOwned.
    assert_fails_with(env.send(&[ix]), "Custom(3011)");
}

#[test]
fn rejects_mint_not_owned_by_token_2022() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);

    // A system-owned account in the mint slot (owner check fires before the ATA
    // derivation, so the mismatched ATA never gets a say).
    let fake_mint = env.payer.pubkey();
    let ix = burn_ix(&pda, &fake_mint, &ata, burn_deposit_data(viz_account, 1));
    // Anchor AccountOwnedByWrongProgram.
    assert_fails_with(env.send(&[ix]), "Custom(3007)");
}

#[test]
fn rejects_non_associated_token_account() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    env.create_ata(&pda);
    // A perfectly valid Token-2022 ATA — but owned by the payer, not the PDA.
    let payer_pub = env.payer.pubkey();
    let payer_ata = env.create_ata(&payer_pub);
    env.mint_to(&payer_ata, 100);

    let ix = burn_ix(&pda, &env.mint.clone(), &payer_ata, burn_deposit_data(viz_account, 1));
    // Anchor ConstraintTokenOwner — the owner-field check fires before the
    // associated-address check.
    assert_fails_with(env.send(&[ix]), "Custom(2015)");
}

#[test]
fn rejects_non_ata_token_account_owned_by_pda() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    // A plain (non-associated) Token-2022 account whose owner field IS the PDA —
    // reachable on-chain via initialize_account3, which needs no owner signature.
    let acc_kp = Keypair::new();
    let rent = env.svm.minimum_balance_for_rent_exemption(TokenAccount::LEN);
    let create_ix = solana_system_interface::instruction::create_account(
        &env.payer.pubkey(),
        &acc_kp.pubkey(),
        rent,
        TokenAccount::LEN as u64,
        &TOKEN_2022_PROGRAM_ID,
    );
    let init_ix =
        initialize_account3(&TOKEN_2022_PROGRAM_ID, &acc_kp.pubkey(), &env.mint.clone(), &pda)
            .unwrap();
    let bh = env.svm.latest_blockhash();
    env.svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[create_ix, init_ix],
            Some(&env.payer.pubkey()),
            &[&env.payer, &acc_kp],
            bh,
        ))
        .expect("create + init token account");

    let ix = burn_ix(&pda, &env.mint.clone(), &acc_kp.pubkey(), burn_deposit_data(viz_account, 1));
    // Owner field matches, so this reaches the address check: Anchor ConstraintAssociated.
    assert_fails_with(env.send(&[ix]), "Custom(2009)");
}

#[test]
fn rejects_ata_of_wrong_mint() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    // The PDA's real ATA — but for a different mint. Owner field matches, so the
    // fault is only visible in the associated-address derivation.
    let other_mint = env.new_mint();
    let ix = create_associated_token_account_idempotent(
        &env.payer.pubkey(),
        &pda,
        &other_mint,
        &TOKEN_2022_PROGRAM_ID,
    );
    env.send(&[ix]).expect("create other-mint ATA");
    let other_ata =
        get_associated_token_address_with_program_id(&pda, &other_mint, &TOKEN_2022_PROGRAM_ID);

    let ix = burn_ix(&pda, &env.mint.clone(), &other_ata, burn_deposit_data(viz_account, 1));
    // Anchor ConstraintAssociated (associated_token has no separate mint-field check).
    assert_fails_with(env.send(&[ix]), "Custom(2009)");
}

#[test]
fn rejects_uncreated_deposit_ata() {
    let mut env = Env::new();
    let viz_account = "alice";
    // Correct ATA address, but the account was never created → empty and
    // system-owned.
    let (pda, ata) = env.deposit_addrs(viz_account);

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 1));
    // Anchor AccountNotInitialized.
    assert_fails_with(env.send(&[ix]), "Custom(3012)");
}

#[test]
fn rejects_uncreated_mint() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);

    // A nonexistent account (0 lamports, system-owned) in the mint slot.
    let ix = burn_ix(&pda, &Pubkey::new_unique(), &ata, burn_deposit_data(viz_account, 1));
    // Anchor AccountNotInitialized.
    assert_fails_with(env.send(&[ix]), "Custom(3012)");
}

#[test]
fn rejects_lamport_funded_uncreated_ata() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, ata) = env.deposit_addrs(viz_account);
    // Someone transferred lamports to the uncreated ATA address: still
    // system-owned, but no longer "not initialized" in Anchor's book.
    let payer_pub = env.payer.pubkey();
    let fund_ix = solana_system_interface::instruction::transfer(&payer_pub, &ata, 1_000_000);
    env.send(&[fund_ix]).expect("fund uncreated ATA address");

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 1));
    // Anchor AccountOwnedByWrongProgram.
    assert_fails_with(env.send(&[ix]), "Custom(3007)");
}

// ──── CPI behavior ───────────────────────────────────────────────────────────

#[test]
fn propagates_token_error_when_burning_more_than_balance() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 100);

    let ix = burn_ix(&pda, &env.mint.clone(), &ata, burn_deposit_data(viz_account, 200));
    // Token-2022 InsufficientFunds = custom error 1, surfaced through the CPI.
    assert_fails_with(env.send(&[ix]), "Custom(1)");
    assert_eq!(env.balance(&ata), 100, "failed burn must not change the balance");
}

// ──── Anchor ABI compatibility quirks ────────────────────────────────────────

#[test]
fn tolerates_trailing_data_and_extra_accounts() {
    let mut env = Env::new();
    let viz_account = "alice";
    let (pda, _) = env.deposit_addrs(viz_account);
    let ata = env.create_ata(&pda);
    env.mint_to(&ata, 100);

    // Anchor's instruction deserializer ignores bytes after the last arg and
    // accounts after the last declared one; the rewrite must keep both.
    let mut data = burn_deposit_data(viz_account, 40);
    data.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
    let mut ix = burn_ix(&pda, &env.mint.clone(), &ata, data);
    ix.accounts.push(AccountMeta::new_readonly(env.payer.pubkey(), false));
    env.send(&[ix]).unwrap_or_else(|e| panic!("trailing data/accounts must be tolerated: {:?}", e));
    assert_eq!(env.balance(&ata), 60);
}

// ──── test: hardcoded program-id constants match the SPL interface crates ─────

#[test]
fn program_id_constants_match_spl_crates() {
    assert_eq!(
        gateway_deposit::TOKEN_2022_ID.as_ref(),
        TOKEN_2022_PROGRAM_ID.as_ref(),
        "TOKEN_2022_ID byte constant drifted"
    );
    assert_eq!(
        gateway_deposit::ATA_PROGRAM_ID.as_ref(),
        spl_associated_token_account_interface::program::ID.as_ref(),
        "ATA_PROGRAM_ID byte constant drifted"
    );
    assert_eq!(
        gateway_deposit::SYSTEM_PROGRAM_ID.as_ref(),
        [0u8; 32].as_ref(),
        "SYSTEM_PROGRAM_ID must be all zeros"
    );
    assert_eq!(gateway_deposit::BURN_DEPOSIT_DISC, BURN_DEPOSIT_DISC);
}

// ──── test: IDL exposes exactly one instruction ───────────────────────────────

#[test]
fn idl_has_exactly_one_instruction_burn_deposit() {
    // Load the IDL JSON at compile time.
    let idl_str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/idl/gateway_deposit.json"
    ));
    let idl: serde_json::Value = serde_json::from_str(idl_str).expect("parse IDL");

    let instructions = idl["instructions"]
        .as_array()
        .expect("instructions array");
    assert_eq!(instructions.len(), 1, "IDL must have exactly one instruction");

    let name = instructions[0]["name"].as_str().expect("instruction name");
    assert_eq!(name, "burn_deposit", "the single instruction must be burn_deposit");

    // No transfer/withdraw/send/move instructions.
    let has_transfer_path = instructions.iter().any(|i| {
        let n = i["name"].as_str().unwrap_or("");
        n.to_ascii_lowercase().contains("transfer")
            || n.to_ascii_lowercase().contains("withdraw")
            || n.to_ascii_lowercase().contains("send")
            || n.to_ascii_lowercase().contains("move")
    });
    assert!(!has_transfer_path, "IDL must not expose any transfer/withdraw path");
}
