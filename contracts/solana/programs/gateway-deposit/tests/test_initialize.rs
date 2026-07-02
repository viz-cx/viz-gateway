/// burn_deposit litesvm integration tests.
///
/// These tests run fully in-process via LiteSVM — no external validator or
/// `solana-test-validator` process is needed.  `cargo test` is the entry point.
use litesvm::LiteSVM;
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
    instruction::{initialize_mint2, mint_to},
    state::Account as TokenAccount,
    ID as TOKEN_2022_PROGRAM_ID,
};

// ──── helpers ────────────────────────────────────────────────────────────────

const GATEWAY_DEPOSIT_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1");

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

/// Create a fresh LiteSVM with all default programs loaded (Token-2022, ATA, …).
fn make_svm() -> LiteSVM {
    LiteSVM::new()
}

// ──── test: balance decreases by the burned amount ───────────────────────────

#[test]
fn burns_exactly_amount_from_deposit_ata() {
    let mut svm = make_svm();

    // Load our program .so (built by `anchor build`; path is relative to CARGO_MANIFEST_DIR).
    let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent() // programs/gateway-deposit  → programs
        .unwrap()
        .parent() // programs → contracts/solana
        .unwrap()
        .join("target/deploy/gateway_deposit.so");
    let so_bytes = std::fs::read(&so_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", so_path.display(), e));
    svm.add_program(GATEWAY_DEPOSIT_PROGRAM_ID, &so_bytes)
        .unwrap();

    // Fund a payer.
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    // Create Token-2022 mint (mint authority = payer, no freeze authority, 3 decimals).
    let mint_kp = Keypair::new();
    let mint_rent = svm.minimum_balance_for_rent_exemption(spl_token_2022_interface::state::Mint::LEN);
    let create_mint_acc_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint_kp.pubkey(),
        mint_rent,
        spl_token_2022_interface::state::Mint::LEN as u64,
        &TOKEN_2022_PROGRAM_ID,
    );
    let init_mint_ix = initialize_mint2(
        &TOKEN_2022_PROGRAM_ID,
        &mint_kp.pubkey(),
        &payer.pubkey(),
        None,
        3,
    )
    .unwrap();
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_mint_acc_ix, init_mint_ix],
        Some(&payer.pubkey()),
        &[&payer, &mint_kp],
        bh,
    ))
    .expect("create + init mint");

    // Derive deposit PDA (seeds = ["deposit", viz_account]).
    let viz_account = "alice";
    let (deposit_pda, _bump) = Pubkey::find_program_address(
        &[b"deposit", viz_account.as_bytes()],
        &GATEWAY_DEPOSIT_PROGRAM_ID,
    );

    // Create the ATA for the deposit PDA (Token-2022).
    let ata_addr = get_associated_token_address_with_program_id(
        &deposit_pda,
        &mint_kp.pubkey(),
        &TOKEN_2022_PROGRAM_ID,
    );
    let create_ata_ix = create_associated_token_account_idempotent(
        &payer.pubkey(),
        &deposit_pda,
        &mint_kp.pubkey(),
        &TOKEN_2022_PROGRAM_ID,
    );
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_ata_ix],
        Some(&payer.pubkey()),
        &[&payer],
        bh,
    ))
    .expect("create ATA");

    // Mint 1 000 tokens to the ATA (mint authority signs).
    let mint_to_ix = mint_to(
        &TOKEN_2022_PROGRAM_ID,
        &mint_kp.pubkey(),
        &ata_addr,
        &payer.pubkey(),
        &[],
        1_000,
    )
    .unwrap();
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[mint_to_ix],
        Some(&payer.pubkey()),
        &[&payer],
        bh,
    ))
    .expect("mint to ATA");

    // Verify starting balance = 1 000.
    // Note: Token-2022 ATAs may have >165 bytes (account-type byte + extension TLV).
    // `Pack::unpack` checks for exact length, so we use `unpack_from_slice` directly.
    let acc_before = svm.get_account(&ata_addr).expect("ATA account");
    let tok_before = TokenAccount::unpack_from_slice(&acc_before.data).expect("unpack before");
    assert_eq!(tok_before.amount, 1_000, "starting balance should be 1000");

    // ── Call burn_deposit(viz_account="alice", amount=400) ──────────────────
    let ix = Instruction {
        program_id: GATEWAY_DEPOSIT_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(deposit_pda, false),         // deposit_authority (PDA)
            AccountMeta::new(mint_kp.pubkey(), false),             // mint (writable)
            AccountMeta::new(ata_addr, false),                     // deposit_ata (writable)
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false), // token_program
        ],
        data: burn_deposit_data(viz_account, 400),
    };
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        bh,
    ))
    .unwrap_or_else(|e| panic!("burn_deposit failed: {:?}", e));

    // Assert: balance is now 600.
    let acc_after = svm.get_account(&ata_addr).expect("ATA account after");
    let tok_after = TokenAccount::unpack_from_slice(&acc_after.data).expect("unpack after");
    assert_eq!(tok_after.amount, 600, "balance after burn should be 600");
}

// ──── test: 17-byte viz_account is rejected with AccountNameTooLong ──────────

#[test]
fn rejects_viz_account_longer_than_16_bytes() {
    let mut svm = make_svm();

    let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target/deploy/gateway_deposit.so");
    let so_bytes = std::fs::read(&so_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", so_path.display(), e));
    svm.add_program(GATEWAY_DEPOSIT_PROGRAM_ID, &so_bytes)
        .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    // Create Token-2022 mint.
    let mint_kp = Keypair::new();
    let mint_rent = svm.minimum_balance_for_rent_exemption(spl_token_2022_interface::state::Mint::LEN);
    let create_mint_acc_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint_kp.pubkey(),
        mint_rent,
        spl_token_2022_interface::state::Mint::LEN as u64,
        &TOKEN_2022_PROGRAM_ID,
    );
    let init_mint_ix = initialize_mint2(
        &TOKEN_2022_PROGRAM_ID,
        &mint_kp.pubkey(),
        &payer.pubkey(),
        None,
        3,
    )
    .unwrap();
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_mint_acc_ix, init_mint_ix],
        Some(&payer.pubkey()),
        &[&payer, &mint_kp],
        bh,
    ))
    .expect("create + init mint");

    // 17-byte account name (one byte over the 16-byte Graphene limit).
    let long_account = "twelve345678nine0"; // 17 chars
    assert_eq!(long_account.len(), 17, "fixture must be exactly 17 bytes");

    let (deposit_pda, _bump) = Pubkey::find_program_address(
        &[b"deposit", long_account.as_bytes()],
        &GATEWAY_DEPOSIT_PROGRAM_ID,
    );
    let ata_addr = get_associated_token_address_with_program_id(
        &deposit_pda,
        &mint_kp.pubkey(),
        &TOKEN_2022_PROGRAM_ID,
    );
    // Create the ATA so the accounts exist — the guard fires before the burn CPI.
    let create_ata_ix = create_associated_token_account_idempotent(
        &payer.pubkey(),
        &deposit_pda,
        &mint_kp.pubkey(),
        &TOKEN_2022_PROGRAM_ID,
    );
    let bh = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_ata_ix],
        Some(&payer.pubkey()),
        &[&payer],
        bh,
    ))
    .expect("create ATA");

    let ix = Instruction {
        program_id: GATEWAY_DEPOSIT_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(deposit_pda, false),
            AccountMeta::new(mint_kp.pubkey(), false),
            AccountMeta::new(ata_addr, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
        ],
        data: burn_deposit_data(long_account, 1),
    };
    let bh = svm.latest_blockhash();
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        bh,
    ));
    assert!(
        result.is_err(),
        "burn_deposit with 17-byte viz_account must fail"
    );
    // Anchor custom errors are base 6000; AccountNameTooLong is variant 0 → error code 6000.
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("6000"),
        "expected error code 6000 (AccountNameTooLong), got: {err_str}"
    );
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
