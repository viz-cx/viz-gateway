// SPIKE: wVIZ metadata-authority verification + hand-off (companion to solana-upgrade-authority-spike).
// The mint's MetadataPointer authority and token-metadata updateAuthority control what wallets
// display for wVIZ; both start on the single deploy payer. This exercises the pure core the enforce
// script acts on, offline (no cluster): the fail-closed verdict, the SPL-multisig-target guard
// (token-metadata instructions require the authority to be is_signer — a multisig never is, so a
// hand-off to one bricks metadata forever), and both instruction layouts.
//
// Run: node tools/solana-metadata-authority-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const { AuthorityType, MULTISIG_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const {
  evaluateMetadataAuthority,
  isSplTokenMultisigAccount,
  buildMetadataHandoffIxs,
} = require("../contracts/solana/dist/metadataAuthority");

function verdictFailsClosed() {
  const target = Keypair.generate().publicKey.toBase58();
  const payer = Keypair.generate().publicKey.toBase58();
  const foreign = Keypair.generate().publicKey.toBase58();

  // SECURED: both on the federation authority; also with one field frozen (None).
  let v = evaluateMetadataAuthority({ state: { updateAuthority: target, pointerAuthority: target }, expected: target });
  assert.deepStrictEqual([v.status, v.ok], ["SECURED", true], "both on target → SECURED/ok");
  v = evaluateMetadataAuthority({ state: { updateAuthority: target, pointerAuthority: null }, expected: target });
  assert.deepStrictEqual([v.status, v.ok], ["SECURED", true], "target + None → SECURED/ok");

  // IMMUTABLE: both None is terminal.
  v = evaluateMetadataAuthority({ state: { updateAuthority: null, pointerAuthority: null }, expected: target });
  assert.deepStrictEqual([v.status, v.ok], ["IMMUTABLE", true], "both None → IMMUTABLE/ok");

  // UNSAFE, payer holds both → handoff possible; foreign key anywhere → not.
  v = evaluateMetadataAuthority({ state: { updateAuthority: payer, pointerAuthority: payer }, expected: target, payer });
  assert.deepStrictEqual([v.status, v.ok, v.canHandoff], ["UNSAFE", false, true], "payer-held → UNSAFE, handoff OK");
  v = evaluateMetadataAuthority({ state: { updateAuthority: payer, pointerAuthority: foreign }, expected: target, payer });
  assert.deepStrictEqual([v.status, v.ok, v.canHandoff], ["UNSAFE", false, false], "any foreign field → no handoff");

  // MISCONFIGURED: no expected authority → cannot verify anything.
  v = evaluateMetadataAuthority({ state: { updateAuthority: payer, pointerAuthority: payer }, expected: "" });
  assert.deepStrictEqual([v.status, v.ok], ["MISCONFIGURED", false], "no expected → MISCONFIGURED");
  console.log("[solana-metadata-authority] fail-closed verdict (SECURED/IMMUTABLE/UNSAFE/MISCONFIGURED) OK");
}

function multisigTargetGuard() {
  // An SPL Token multisig is a fixed-size account under either token program — exactly what must
  // never receive the metadata authorities.
  assert.ok(isSplTokenMultisigAccount(TOKEN_PROGRAM_ID.toBase58(), MULTISIG_SIZE), "legacy token multisig detected");
  assert.ok(isSplTokenMultisigAccount(TOKEN_2022_PROGRAM_ID.toBase58(), MULTISIG_SIZE), "token-2022 multisig detected");
  assert.ok(!isSplTokenMultisigAccount("11111111111111111111111111111111", MULTISIG_SIZE), "system-owned (Squads PDA style) passes");
  assert.ok(!isSplTokenMultisigAccount(TOKEN_2022_PROGRAM_ID.toBase58(), 165), "token account (165B) passes");
  console.log("[solana-metadata-authority] SPL-multisig target guard OK");
}

function handoffInstructionLayouts() {
  const mint = Keypair.generate().publicKey;
  const current = Keypair.generate().publicKey;
  const target = Keypair.generate().publicKey;
  const state = { updateAuthority: current.toBase58(), pointerAuthority: current.toBase58() };
  const ixs = buildMetadataHandoffIxs({ mint, state, newAuthority: target });
  assert.strictEqual(ixs.length, 2, "both authorities move");

  // SetAuthority(MetadataPointer): [SetAuthority(6), MetadataPointer(12), Some(1), 32B new authority].
  const [ptr, upd] = ixs;
  assert.ok(ptr.programId.equals(TOKEN_2022_PROGRAM_ID), "pointer ix targets Token-2022");
  assert.strictEqual(ptr.data[0], 6, "data[0] = SetAuthority discriminant");
  assert.strictEqual(ptr.data[1], AuthorityType.MetadataPointer, "data[1] = MetadataPointer authority type");
  assert.strictEqual(AuthorityType.MetadataPointer, 12, "MetadataPointer enum value locked");
  assert.ok(Buffer.from(ptr.data.subarray(3)).equals(target.toBuffer()), "new authority in data tail");
  assert.ok(ptr.keys[0].pubkey.equals(mint) && ptr.keys[0].isWritable, "mint is writable");
  assert.ok(ptr.keys[1].pubkey.equals(current) && ptr.keys[1].isSigner, "current authority signs");

  // UpdateAuthority (token-metadata interface): 8B discriminator + 32B new authority; on-mint
  // metadata means the metadata account IS the mint.
  assert.ok(upd.programId.equals(TOKEN_2022_PROGRAM_ID), "update ix targets Token-2022");
  assert.strictEqual(upd.data.length, 8 + 32, "discriminator + pubkey");
  assert.ok(Buffer.from(upd.data.subarray(8)).equals(target.toBuffer()), "new authority in data tail");
  assert.ok(upd.keys[0].pubkey.equals(mint) && upd.keys[0].isWritable, "metadata account == mint, writable");
  assert.ok(upd.keys[1].pubkey.equals(current) && upd.keys[1].isSigner, "old authority signs");

  // Already-secured fields build nothing (idempotent re-run).
  assert.strictEqual(
    buildMetadataHandoffIxs({ mint, state: { updateAuthority: target.toBase58(), pointerAuthority: null }, newAuthority: target }).length,
    0,
    "secured + frozen → nothing to move",
  );
  console.log("[solana-metadata-authority] hand-off instruction layouts OK");
}

verdictFailsClosed();
multisigTargetGuard();
handoffInstructionLayouts();
console.log("solana-metadata-authority-spike: all assertions passed");
