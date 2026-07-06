// SPIKE: gateway-deposit program upgrade-authority verification (H3).
// The burn-only program can't steal — UNLESS someone upgrades it. Whoever holds the BPF upgrade
// authority can swap in a drain-everything instruction. So the authority must be the federation
// M-of-N multisig, verified on-chain, and eventually dropped (immutable). This exercises the pure
// core the deploy/enforce script acts on, offline (no cluster): ProgramData parsing, PDA derivation,
// the fail-closed verdict, and the SetAuthority instruction layout.
//
// NOTE: the on-chain read/hand-off (enforceProgramAuthority.ts) is NOT tested on a live cluster —
// no solana-test-validator here. This spike locks the account layout + decision logic; the send
// path must be dry-run on devnet before mainnet.
//
// Run: node tools/solana-upgrade-authority-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { PublicKey, Keypair } = require("@solana/web3.js");
const {
  BPF_UPGRADEABLE_LOADER_ID,
  deriveProgramDataAddress,
  parseProgramAccount,
  parseUpgradeAuthority,
  evaluateUpgradeAuthority,
  buildSetUpgradeAuthorityIx,
} = require("../contracts/solana/dist/programAuthority");

// --- buffer builders mirroring UpgradeableLoaderState (bincode: 4-byte u32 LE enum tag) ---
function programAccountBuf(programDataAddr) {
  const b = Buffer.alloc(4 + 32);
  b.writeUInt32LE(2, 0); // Program
  Buffer.from(programDataAddr.toBuffer()).copy(b, 4);
  return b;
}
function programDataBuf(slot, authority /* PublicKey|null */) {
  const b = Buffer.alloc(4 + 8 + 1 + (authority ? 32 : 0));
  b.writeUInt32LE(3, 0); // ProgramData
  b.writeBigUInt64LE(BigInt(slot), 4);
  b.writeUInt8(authority ? 1 : 0, 12);
  if (authority) Buffer.from(authority.toBuffer()).copy(b, 13);
  return b;
}

function parseRoundTrips() {
  const programId = Keypair.generate().publicKey;
  const pda = deriveProgramDataAddress(programId);
  // The program account points at exactly the PDA we derive.
  assert.ok(parseProgramAccount(programAccountBuf(pda)).equals(pda), "program account → its ProgramData PDA");
  // A non-Program enum tag (e.g. Buffer=1) must throw, not silently misparse.
  const bad = Buffer.alloc(40); bad.writeUInt32LE(1, 0);
  assert.throws(() => parseProgramAccount(bad), /not an upgradeable program/, "Buffer(1) tag rejected");

  // ProgramData: Some(authority) and None(immutable).
  const auth = Keypair.generate().publicKey;
  const some = parseUpgradeAuthority(programDataBuf(1234, auth));
  assert.strictEqual(some.slot, 1234n, "slot parsed");
  assert.strictEqual(some.upgradeAuthority, auth.toBase58(), "Some(authority) parsed");
  const none = parseUpgradeAuthority(programDataBuf(1234, null));
  assert.strictEqual(none.upgradeAuthority, null, "None → immutable");
  // Wrong enum tag throws.
  const bd = Buffer.alloc(13); bd.writeUInt32LE(2, 0);
  assert.throws(() => parseUpgradeAuthority(bd), /!= ProgramData/, "non-ProgramData tag rejected");
  console.log("[solana-upgrade-authority] ProgramData/Program parsing + PDA derivation OK");
}

function verdictFailsClosed() {
  const multisig = Keypair.generate().publicKey.toBase58();
  const payer = Keypair.generate().publicKey.toBase58();
  const foreign = Keypair.generate().publicKey.toBase58();

  // SECURED: authority is the multisig.
  let v = evaluateUpgradeAuthority({ current: multisig, expectedMultisig: multisig });
  assert.deepStrictEqual([v.status, v.ok], ["SECURED", true], "multisig-held → SECURED/ok");

  // IMMUTABLE: None authority is the hardened end state.
  v = evaluateUpgradeAuthority({ current: null, expectedMultisig: multisig });
  assert.deepStrictEqual([v.status, v.ok], ["IMMUTABLE", true], "None → IMMUTABLE/ok");

  // UNSAFE (foreign key we don't control): fail closed, cannot auto-hand-off.
  v = evaluateUpgradeAuthority({ current: foreign, expectedMultisig: multisig, payer });
  assert.deepStrictEqual([v.status, v.ok, v.canHandoff], ["UNSAFE", false, false], "foreign key → UNSAFE, no handoff");

  // UNSAFE (payer holds it): fail closed but hand-off is possible.
  v = evaluateUpgradeAuthority({ current: payer, expectedMultisig: multisig, payer });
  assert.deepStrictEqual([v.status, v.ok, v.canHandoff], ["UNSAFE", false, true], "payer-held → UNSAFE, handoff OK");

  // MISCONFIGURED: no expected multisig → cannot verify anything → not ok.
  v = evaluateUpgradeAuthority({ current: payer, expectedMultisig: "" });
  assert.deepStrictEqual([v.status, v.ok], ["MISCONFIGURED", false], "no expected multisig → MISCONFIGURED");
  console.log("[solana-upgrade-authority] fail-closed verdict (SECURED/IMMUTABLE/UNSAFE/MISCONFIGURED) OK");
}

function setAuthorityInstructionLayout() {
  const programDataAddress = Keypair.generate().publicKey;
  const currentAuthority = Keypair.generate().publicKey;
  const newAuthority = Keypair.generate().publicKey;
  const ix = buildSetUpgradeAuthorityIx({ programDataAddress, currentAuthority, newAuthority });
  assert.ok(ix.programId.equals(BPF_UPGRADEABLE_LOADER_ID), "ix targets the BPF Upgradeable Loader");
  assert.deepStrictEqual([...ix.data], [4, 0, 0, 0], "data = SetAuthority(4) u32 LE");
  assert.strictEqual(ix.keys.length, 3, "3 accounts");
  assert.ok(ix.keys[0].pubkey.equals(programDataAddress) && ix.keys[0].isWritable, "ProgramData is writable");
  assert.ok(ix.keys[1].pubkey.equals(currentAuthority) && ix.keys[1].isSigner, "current authority signs");
  assert.ok(ix.keys[2].pubkey.equals(newAuthority) && !ix.keys[2].isSigner, "new authority is not a signer");
  console.log("[solana-upgrade-authority] SetAuthority instruction layout OK");
}

parseRoundTrips();
verdictFailsClosed();
setAuthorityInstructionLayout();
console.log("solana-upgrade-authority-spike: all assertions passed");
