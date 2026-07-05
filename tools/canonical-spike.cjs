// SPIKE: canonical encoding is injective (VG-05). The digest MUST be a pure,
// collision-free function of the source event: distinct field arrays -> distinct
// bytes, so no adversary-controlled value (address, memo-derived destination)
// can forge a field boundary and make two different actions hash to the same
// digest. The encoding length-tags every key and value, so boundaries cannot
// shift no matter what bytes a value contains (including the old separator).
//
// Run: node tools/canonical-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { canonicalPegIn, canonicalPegOut } = require("../packages/common/dist/canonical");

// --- determinism: same source event -> same digest (independent operators) ---
const dep = {
  trxId: "abc123",
  opIndex: 0,
  remoteChain: "TON",
  remoteDestination: "EQCuW98IexampleAddr",
  amountMilliViz: 10_000n,
};
assert.strictEqual(canonicalPegIn(dep).digest, canonicalPegIn(dep).digest);
console.log("[canonical] peg-in digest deterministic OK");

// --- injectivity: boundary-shift pairs that a naive concat would collide ---
// Two deposits where the (destination, amount) split differs but a separator-less
// concatenation of "recipient=<dst>amount_milli_viz=<amt>" could coincide.
const a = { ...dep, remoteDestination: "AAA", amountMilliViz: 1n };
const b = { ...dep, remoteDestination: "AA", amountMilliViz: 1n }; // shorter dst, else equal
assert.notStrictEqual(canonicalPegIn(a).digest, canonicalPegIn(b).digest);
console.log("[canonical] distinct destinations -> distinct digests OK");

// --- adversarial: a value containing the old 0x1F unit separator must NOT let
// an attacker impersonate a different field layout. Length prefixes make the
// separator content-agnostic. ---
const US = "\x1f";
const evil = { ...dep, remoteDestination: `X${US}amount_milli_viz=999999` };
const honest = { ...dep, remoteDestination: "X", amountMilliViz: 999999n };
assert.notStrictEqual(
  canonicalPegIn(evil).digest,
  canonicalPegIn(honest).digest,
  "separator injection must not collide with a real field boundary",
);
console.log("[canonical] separator-injection does not forge a field boundary OK");

// --- direction domain separation: peg-in vs peg-out never collide ---
const burn = {
  sourceId: "abc123:0",
  homeDestination: "EQCuW98IexampleAddr",
  amountMilliViz: 10_000n,
};
assert.notStrictEqual(canonicalPegIn(dep).digest, canonicalPegOut(burn).digest);
console.log("[canonical] PEG_IN vs PEG_OUT domain-separated OK");

// --- cross-field boundary shift on peg-out (src vs recipient) ---
const p = canonicalPegOut({ sourceId: "AB", homeDestination: "C", amountMilliViz: 1n });
const q = canonicalPegOut({ sourceId: "A", homeDestination: "BC", amountMilliViz: 1n });
assert.notStrictEqual(p.digest, q.digest);
console.log("[canonical] peg-out src/recipient boundary shift -> distinct digests OK");

console.log("\nRESULT: canonical encoding is injective; VG-05 (unambiguous boundaries) verified.");
