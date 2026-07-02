/**
 * Smoke-test for PDA-based deposit address derivation.
 *
 * Verifies that:
 *  [1] depositAddress(programId, vizAccount) == on-chain PDA(["deposit", viz], program)
 *  [2] distinct VIZ accounts -> distinct deposit addresses
 *  [3] buildBurnDepositIx returns an instruction targeting the right program
 *      and containing both the PDA authority and its ATA in its account keys
 *
 * Run after build: node tools/deposit-pda-spike.cjs
 */

"use strict";
const { PublicKey } = require("@solana/web3.js");
const assert = require("node:assert");
const { depositAddress, depositAta, buildBurnDepositIx } =
  require("../packages/solana-watcher/dist/depositAddress");

const PROGRAM = "GateWayDep1111111111111111111111111111111111"; // any valid base58 pubkey
const MINT = "So11111111111111111111111111111111111111112";

// [1] address == on-chain findProgramAddress(["deposit", viz])
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("deposit"), Buffer.from("alice", "utf8")], new PublicKey(PROGRAM));
assert.equal(depositAddress(PROGRAM, "alice"), pda.toBase58(), "[1] PDA mismatch");

// [2] distinct accounts -> distinct addresses
assert.notEqual(depositAddress(PROGRAM, "alice"), depositAddress(PROGRAM, "bob"), "[2]");

// [2b] depositAta returns a valid Token-2022 ATA address (not the owner itself)
const ata = depositAta(PROGRAM, "alice", MINT);
new PublicKey(ata); // throws if invalid base58 or off-curve
assert.notEqual(ata, depositAddress(PROGRAM, "alice"), "[2b] ATA should differ from PDA owner");

// [3] burn ix targets the program, carries the PDA authority + its ATA
const ix = buildBurnDepositIx({ programId: PROGRAM, vizAccount: "alice", amount: 400n, mint: MINT });
assert.equal(ix.programId.toBase58(), PROGRAM, "[3] wrong program");
assert.ok(ix.keys.some((k) => k.pubkey.toBase58() === pda.toBase58()), "[3] PDA authority missing");
assert.ok(ix.keys.some((k) => k.pubkey.toBase58() === ata), "[3] deposit ATA missing from ix keys");

console.log("deposit-pda-spike [1-3]: all checks passed");

// [4] SolanaChain builds a burn tx whose sole instruction is burn_deposit
const { buildBurnTxForTest } = require("../packages/solana-watcher/dist/solanaChain");
const { Keypair } = require("@solana/web3.js");
const tx = buildBurnTxForTest({ programId: PROGRAM, mint: MINT, vizAccount: "alice", amount: 400n, payer: Keypair.generate().publicKey });
assert.equal(tx.instructions.length, 1, "[4] expected exactly one instruction");
assert.equal(tx.instructions[0].programId.toBase58(), PROGRAM, "[4] not the gateway program");
console.log("deposit-pda-spike [4]: burn tx shape ok");

console.log("deposit-pda-spike: all checks passed");
