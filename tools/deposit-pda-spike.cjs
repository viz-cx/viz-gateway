/**
 * Smoke-test for PDA-based deposit address derivation.
 *
 * Verifies that:
 *  [1] depositAddress(programId, vizAccount) == on-chain PDA(["deposit", viz], program)
 *  [2] distinct VIZ accounts -> distinct deposit addresses
 *  [3] buildBurnDepositIx returns an instruction targeting the right program
 *      and containing the PDA authority in its account keys
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

// [3] burn ix targets the program, carries the PDA authority + its ATA
const ix = buildBurnDepositIx({ programId: PROGRAM, vizAccount: "alice", amount: 400n, mint: MINT });
assert.equal(ix.programId.toBase58(), PROGRAM, "[3] wrong program");
assert.ok(ix.keys.some((k) => k.pubkey.toBase58() === pda.toBase58()), "[3] PDA authority missing");

console.log("deposit-pda-spike: all checks passed");
