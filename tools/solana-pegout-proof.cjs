// LIVE PROOF: Solana peg-out burn path end-to-end against a local test validator.
// Proves the gateway-deposit program accepts a burn_deposit instruction and
// correctly reduces the ATA balance and mint supply.
//
// Steps:
//   1. Deploy the gateway-deposit program via `anchor deploy` (localnet).
//   2. Create a Token-2022 wVIZ mint (payer = throwaway funded keypair).
//   3. Derive depositAddress(programId, "alice") and its ATA.
//   4. getOrCreateAssociatedTokenAccount for the deposit PDA (allowOwnerOffCurve=true).
//   5. mintTo the deposit ATA (MINT_AMOUNT).
//   6. Build + send burn_deposit via buildBurnDepositIx (BURN_AMOUNT <= MINT_AMOUNT).
//   7. Assert ATA balance and mint supply dropped by BURN_AMOUNT.
//   8. Print the burn signature.
//
// Env (all optional — defaults work against a fresh local validator):
//   SOLANA_RPC_URL      defaults to http://127.0.0.1:8899
//   SOLANA_PROGRAM_ID   override program ID (default: reads Anchor.toml)
//
// Run:
//   source ~/.cargo/env
//   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
//   solana-test-validator -r &
//   sleep 5
//   node tools/solana-pegout-proof.cjs
//   kill %1

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");
const path = require("node:path");

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} = require("@solana/spl-token");
const {
  depositAddress,
  depositAta,
  buildBurnDepositIx,
} = require("../packages/solana-watcher/dist/depositAddress");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VIZ_ACCOUNT = "alice";
const MINT_AMOUNT = 5_000_000n; // 5,000 wVIZ (3 decimals = 5,000.000)
const BURN_AMOUNT = 3_000_000n; // 3,000 wVIZ burned

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";

// Program ID from Anchor.toml (MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1)
// override with SOLANA_PROGRAM_ID if needed
const DEFAULT_PROGRAM_ID = "MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1";
const PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || DEFAULT_PROGRAM_ID;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function airdrop(conn, pubkey, sol) {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
}

async function mintSupply(conn, mintPubkey) {
  const info = await conn.getAccountInfo(mintPubkey);
  if (!info) return 0n;
  // Token-2022 mint: supply is at offset 36, 8 bytes LE u64
  // Layout: mint_authority(36) + supply(8) + decimals(1) + ...
  // Actually parse from getParsedAccountInfo to avoid manual offset arithmetic
  const parsed = await conn.getParsedAccountInfo(mintPubkey);
  if (!parsed.value) return 0n;
  const data = parsed.value.data;
  if (data && data.parsed && data.parsed.info) {
    return BigInt(data.parsed.info.supply);
  }
  return 0n;
}

// ---------------------------------------------------------------------------
// Deploy the gateway-deposit program to localnet
// ---------------------------------------------------------------------------
// payerKeypair is a @solana/web3.js Keypair already funded on the validator.
// We write its secret key as a byte-array JSON (solana-keygen format) to a
// temp file so `solana program deploy` can use it as --keypair.
// If the program is already deployed (e.g. from a prior run on this validator),
// we skip the deploy.
async function deployProgram(conn, payerKeypair) {
  const programPubkey = new PublicKey(PROGRAM_ID);
  const existing = await conn.getAccountInfo(programPubkey);
  if (existing) {
    console.log("[proof] gateway-deposit already deployed, skipping deploy");
    return;
  }

  const contractsDir = path.resolve(__dirname, "../contracts/solana");
  const soPath = path.resolve(contractsDir, "target/deploy/gateway_deposit.so");
  const programKeypairPath = path.resolve(contractsDir, "target/deploy/gateway_deposit-keypair.json");

  // Write payer secret key to a temp file in solana-keygen JSON format
  const tmpPayerPath = path.join(os.tmpdir(), `viz-proof-payer-${Date.now()}.json`);
  fs.writeFileSync(tmpPayerPath, JSON.stringify(Array.from(payerKeypair.secretKey)));

  console.log("[proof] deploying gateway-deposit program to localnet...");
  try {
    // All args are static paths / fixed strings — no user input interpolated
    const result = execSync(
      `solana program deploy ${soPath} --program-id ${programKeypairPath} --keypair ${tmpPayerPath} --url ${RPC_URL} 2>&1`,
      { encoding: "utf8", timeout: 120_000 }
    );
    console.log("[proof] deploy output:\n" + result.trim());
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    throw new Error(`program deploy failed:\n${output}`);
  } finally {
    try { fs.unlinkSync(tmpPayerPath); } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main proof
// ---------------------------------------------------------------------------
(async () => {
  console.log(`[proof] RPC: ${RPC_URL}`);
  console.log(`[proof] programId: ${PROGRAM_ID}`);

  const conn = new Connection(RPC_URL, "confirmed");

  // Create a throwaway payer keypair and fund it
  const payer = Keypair.generate();
  console.log(`[proof] payer: ${payer.publicKey.toBase58()}`);
  await airdrop(conn, payer.publicKey, 10);
  console.log("[proof] payer funded with 10 SOL");

  // Deploy the program (payer funds the deployment transaction)
  await deployProgram(conn, payer);

  // Create Token-2022 wVIZ mint; payer is the mint authority
  console.log("[proof] creating Token-2022 wVIZ mint...");
  const mintKeypair = Keypair.generate();
  const mintPubkey = await createMint(
    conn,
    payer,           // payer
    payer.publicKey, // mint authority
    null,            // freeze authority (none)
    3,               // decimals
    mintKeypair,     // mint keypair
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`[proof] wVIZ mint: ${mintPubkey.toBase58()}`);

  // Derive the deposit PDA address and its ATA
  const depositPda = depositAddress(PROGRAM_ID, VIZ_ACCOUNT);
  const depositAtaAddr = depositAta(PROGRAM_ID, VIZ_ACCOUNT, mintPubkey.toBase58());
  console.log(`[proof] deposit PDA for "${VIZ_ACCOUNT}": ${depositPda}`);
  console.log(`[proof] deposit ATA: ${depositAtaAddr}`);

  // Create the ATA for the deposit PDA (PDA is off-curve; allowOwnerOffCurve=true)
  const depositPdaPubkey = new PublicKey(depositPda);

  console.log("[proof] creating deposit ATA (allowOwnerOffCurve=true)...");
  const depositAtaAccount = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,             // payer
    mintPubkey,        // mint
    depositPdaPubkey,  // owner (PDA, off-curve)
    true,              // allowOwnerOffCurve
    "confirmed",       // commitment
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`[proof] deposit ATA created: ${depositAtaAccount.address.toBase58()}`);

  // Mint MINT_AMOUNT to the deposit ATA
  console.log(`[proof] minting ${MINT_AMOUNT} to deposit ATA...`);
  await mintTo(
    conn,
    payer,
    mintPubkey,
    depositAtaAccount.address,
    payer, // mint authority
    MINT_AMOUNT,
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("[proof] mint done");

  // Read balances BEFORE burn
  const ataBefore = await getAccount(conn, depositAtaAccount.address, "confirmed", TOKEN_2022_PROGRAM_ID);
  const supplyBefore = await mintSupply(conn, mintPubkey);
  const balanceBefore = BigInt(ataBefore.amount);
  console.log(`[proof] ATA balance before: ${balanceBefore}`);
  console.log(`[proof] mint supply before: ${supplyBefore}`);

  // Build the burn_deposit instruction and send it
  console.log(`[proof] burning ${BURN_AMOUNT} via burn_deposit...`);
  const burnIx = buildBurnDepositIx({
    programId: PROGRAM_ID,
    vizAccount: VIZ_ACCOUNT,
    amount: BURN_AMOUNT,
    mint: mintPubkey.toBase58(),
  });

  const tx = new Transaction().add(burnIx);
  const burnSig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`[proof] burn confirmed: ${burnSig}`);

  // Read balances AFTER burn
  const ataAfter = await getAccount(conn, depositAtaAccount.address, "confirmed", TOKEN_2022_PROGRAM_ID);
  const supplyAfter = await mintSupply(conn, mintPubkey);
  const balanceAfter = BigInt(ataAfter.amount);
  console.log(`[proof] ATA balance after: ${balanceAfter}`);
  console.log(`[proof] mint supply after: ${supplyAfter}`);

  // Assert correctness
  const balanceDelta = balanceBefore - balanceAfter;
  const supplyDelta = supplyBefore - supplyAfter;
  console.log(`[proof] ATA balance delta (burned): ${balanceDelta}`);
  console.log(`[proof] mint supply delta (burned): ${supplyDelta}`);

  assert.strictEqual(balanceDelta, BURN_AMOUNT, `expected ATA delta ${BURN_AMOUNT}, got ${balanceDelta}`);
  assert.strictEqual(supplyDelta, BURN_AMOUNT, `expected supply delta ${BURN_AMOUNT}, got ${supplyDelta}`);

  console.log(`
RESULT: Solana peg-out burn_deposit PROVEN.
  mint:          ${mintPubkey.toBase58()}
  depositPDA:    ${depositPda}
  depositATA:    ${depositAtaAddr}
  balance:       ${balanceBefore} -> ${balanceAfter} (delta -${balanceDelta})
  supply:        ${supplyBefore} -> ${supplyAfter} (delta -${supplyDelta})
  burn sig:      ${burnSig}
`);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
