// SPIKE: peg-out deposit-address derivation + registry (offline).
// Updated for PDA-based derivation (Variant B): each VIZ account gets a deterministic
// Solana PDA deposit address so wVIZ -> VIZ routing needs no memo and no secret key.
// Verifies derivation is stable & unique, the owner/ATA are valid base58,
// and the registry maps address/ata -> VIZ account.
//
// Run: node tools/pegout-address-spike.cjs   (after npm run build)
"use strict";
const assert = require("node:assert");
const { PublicKey } = require("@solana/web3.js");
const { depositAddress, depositAta } = require("../packages/solana-watcher/dist/depositAddress");
const { createStore } = require("../packages/common/dist/store");

const PROGRAM = "GateWayDep1111111111111111111111111111111111"; // placeholder program id
const PROGRAM2 = "Gate2ayDep111111111111111111111111111111111"; // different program id
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // any valid mint (USDC) for ATA derivation

// 1) deterministic: same VIZ account -> same address, every time / every operator.
assert.strictEqual(depositAddress(PROGRAM, "alice"), depositAddress(PROGRAM, "alice"));
console.log("[pegout] derivation stable per VIZ account OK");

// 2) unique: different accounts -> different addresses.
assert.notStrictEqual(depositAddress(PROGRAM, "alice"), depositAddress(PROGRAM, "bob"));
// and a different program -> different address for the same account.
assert.notStrictEqual(depositAddress(PROGRAM, "alice"), depositAddress(PROGRAM2, "alice"));
console.log("[pegout] addresses unique per account and per program OK");

// 3) valid base58 pubkeys; ATA differs from owner and is on the curve-derived path.
const owner = depositAddress(PROGRAM, "alice");
const ata = depositAta(PROGRAM, "alice", MINT);
new PublicKey(owner); // throws if invalid
new PublicKey(ata);
assert.notStrictEqual(owner, ata);
console.log("[pegout] owner + ATA valid base58 OK");

// 4) registry maps both owner and ATA back to the VIZ account.
(async () => {
  const store = createStore("memory:");
  await store.registerDepositAddress({ vizAccount: "alice", solAddress: owner, wvizAta: ata });
  await store.registerDepositAddress({ vizAccount: "alice", solAddress: owner, wvizAta: ata }); // idempotent
  const byOwner = await store.depositAddressBy(owner);
  const byAta = await store.depositAddressBy(ata);
  assert.strictEqual(byOwner.vizAccount, "alice");
  assert.strictEqual(byAta.vizAccount, "alice");
  const scan = await store.depositAddressesForScan(10);
  assert.strictEqual(scan.length, 1);
  console.log("[pegout] registry maps owner/ata -> VIZ account; scan list OK");

  console.log("\nRESULT: peg-out deposit-address derivation + registry verified.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
