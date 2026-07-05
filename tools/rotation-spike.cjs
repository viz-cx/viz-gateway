// SPIKE/TEST: rotation core logic — operator parsing, deterministic authority
// + account_update op building, authority hashing, and a full propose→co-sign→
// merge round-trip proving independent partials over our account_update tx
// merge exactly like the release path (see viz-multisig-spike.cjs).
//
// Run (after `npm run build`): node tools/rotation-spike.cjs
const assert = require("node:assert");
const viz = require("viz-js-lib");
const {
  parseOperators,
  serializeOperators,
  buildActiveAuthority,
  authorityHash,
  buildRotationOp,
  parseManifest,
  buildProposal,
  validateProposal,
  addPartial,
  mergeState,
} = require("../packages/common/dist/index.js");

// A real, serializable memo pubkey (the gateway's memo_key). signTransaction
// serializes the whole account_update op — memo_key included — so the signing
// tests need a valid key here, not a placeholder.
const MEMO = viz.auth.wifToPublic(viz.auth.toWif("gateway", "pw-memo", "memo"));

// --- parse/serialize round-trip ---
const ops = parseOperators("op-1=VIZ1aaa:11aa:So1aaa,op-2=VIZ1bbb:22bb:So1bbb,op-3=VIZ1ccc:33cc:So1ccc");
assert.strictEqual(ops.length, 3);
assert.deepStrictEqual(ops[0], { id: "op-1", vizPubkey: "VIZ1aaa", tonPubkey: "11aa", solanaPubkey: "So1aaa" });
assert.strictEqual(serializeOperators(ops), "op-1=VIZ1aaa:11aa:So1aaa,op-2=VIZ1bbb:22bb:So1bbb,op-3=VIZ1ccc:33cc:So1ccc");
console.log("[parse] operators round-trip OK");

// --- authority is keys-only, sorted, master-free ---
const auth = buildActiveAuthority(ops, 2);
assert.strictEqual(auth.weight_threshold, 2);
assert.deepStrictEqual(auth.account_auths, []);
assert.deepStrictEqual(auth.key_auths, [["VIZ1aaa", 1], ["VIZ1bbb", 1], ["VIZ1ccc", 1]]);
// sorted regardless of input order:
const auth2 = buildActiveAuthority(parseOperators("op-9=VIZ1zzz:00:So9,op-1=VIZ1aaa:11:So1"), 1);
assert.deepStrictEqual(auth2.key_auths, [["VIZ1aaa", 1], ["VIZ1zzz", 1]]);
console.log("[authority] keys-only + sorted OK");

// --- buildRotationOp is deterministic and omits master ---
const op1 = buildRotationOp("viz-gateway", ops, 2, MEMO, "{}");
const op2 = buildRotationOp("viz-gateway", ops, 2, MEMO, "{}");
assert.strictEqual(JSON.stringify(op1), JSON.stringify(op2), "op build is non-deterministic");
assert.strictEqual(op1[0], "account_update");
assert.strictEqual(op1[1].account, "viz-gateway");
assert.strictEqual(op1[1].master, undefined, "master MUST be absent (active-only rotation)");
assert.deepStrictEqual(op1[1].active, auth);
assert.deepStrictEqual(op1[1].regular, auth);
console.log("[op] account_update deterministic, master omitted OK");

// --- authorityHash is stable & order-independent ---
const h1 = authorityHash(buildActiveAuthority(ops, 2));
const h2 = authorityHash(buildActiveAuthority(parseOperators("op-3=VIZ1ccc:33cc:So3,op-1=VIZ1aaa:11aa:So1,op-2=VIZ1bbb:22bb:So2"), 2));
assert.strictEqual(h1, h2, "authorityHash must be order-independent");
console.log("[hash] authorityHash stable OK");

// --- parseManifest validation ---
const m = parseManifest({ n: 2, threshold: 2, operators: [
  { id: "op-1", vizPubkey: "VIZ1aaa", tonPubkey: "11", solanaPubkey: "SoM1" },
  { id: "op-2", vizPubkey: "VIZ1bbb", tonPubkey: "22", solanaPubkey: "SoM2" },
] });
assert.strictEqual(m.n, 2);
assert.strictEqual(m.fees, undefined, "fees absent when not present in manifest");

// manifest with fees section takes precedence over env vars
const mf = parseManifest({ n: 1, threshold: 1, operators: [{ id: "op-1", vizPubkey: "VIZ1aaa", tonPubkey: "11" }],
  fees: { floorMilliViz: 5000, bps: 10, activationSurchargeMilliViz: { SOLANA: 20000, TON: 15000 }, mintGasFloorMilliViz: { SOLANA: 500, TON: 500 } },
});
assert.deepStrictEqual(mf.fees, {
  floorMilliViz: 5000n,
  bps: 10,
  activationSurchargeMilliViz: { SOLANA: 20000n, TON: 15000n },
  mintGasFloorMilliViz: { SOLANA: 500n, TON: 500n },
});
assert.throws(() => parseManifest({ n: 3, threshold: 2, operators: [] }), /operators.length/);
console.log("[manifest] parseManifest validation + fees round-trip OK");

// --- proposal build + validate + tamper rejection + merge round-trip ---
// Three synthetic operator keypairs (stand-ins for HSM-held VIZ active keys).
function kp(seed) {
  const wif = viz.auth.toWif("gateway", `pw-${seed}`, "active");
  return { wif, pub: viz.auth.wifToPublic(wif) };
}
const A = kp("a"), B = kp("b"), C = kp("c");
const newOps = [
  { id: "op-1", vizPubkey: A.pub, tonPubkey: "aa", solanaPubkey: "SoA" },
  { id: "op-2", vizPubkey: B.pub, tonPubkey: "bb", solanaPubkey: "SoB" },
  { id: "op-3", vizPubkey: C.pub, tonPubkey: "cc", solanaPubkey: "SoC" },
];
const taPoS = { refBlockNum: 1234, refBlockPrefix: 5678901, expiration: "2099-01-01T00:00:00" };
const currentActiveHash = "deadbeef";
const proposal = buildProposal({
  chainId: "viz-gateway",
  account: "viz-gateway",
  newOperators: newOps,
  newThreshold: 2,
  memoKey: MEMO,
  jsonMetadata: "{}",
  currentActiveHash,
  taPoS,
});
assert.strictEqual(proposal.version, 1);
assert.strictEqual(proposal.vizTx.operations[0][0], "account_update");
assert.deepStrictEqual(proposal.vizTx.signatures, []);

// validateProposal rebuilds the op and accepts a faithful proposal:
validateProposal(proposal, { chainId: "viz-gateway", nowMs: 0 });
console.log("[proposal] build + validate OK");

// tamper: swap the active authority threshold in the file -> rejected
const tampered = JSON.parse(JSON.stringify(proposal));
tampered.vizTx.operations[0][1].active.weight_threshold = 1;
assert.throws(() => validateProposal(tampered, { chainId: "viz-gateway", nowMs: 0 }), /does not match/);
// wrong chainId -> rejected
assert.throws(() => validateProposal(proposal, { chainId: "other", nowMs: 0 }), /chainId/);
// expired -> rejected
assert.throws(
  () => validateProposal(proposal, { chainId: "viz-gateway", nowMs: Date.parse("2099-01-02T00:00:00Z") }),
  /expired/,
);
console.log("[proposal] tamper/chainId/expiry rejection OK");

// VG-01: multi-op injection — a proposer appends a `transfer` after the faithful
// account_update. operations[0] still validates, but the co-signer signs the WHOLE
// vizTx, so an unguarded validator would authorize the transfer under T-of-N.
// validateProposal must reject any operations.length != 1.
const injected = JSON.parse(JSON.stringify(proposal));
injected.vizTx.operations.push([
  "transfer",
  { from: "viz-gateway", to: "attacker", amount: "999999.000 VIZ", memo: "" },
]);
assert.throws(
  () => validateProposal(injected, { chainId: "viz-gateway", nowMs: 0 }),
  /exactly one operation/,
  "multi-op injection must be rejected (VG-01)",
);
// zero operations -> rejected
const empty = JSON.parse(JSON.stringify(proposal));
empty.vizTx.operations = [];
assert.throws(() => validateProposal(empty, { chainId: "viz-gateway", nowMs: 0 }), /exactly one operation/);
// non-empty extensions -> rejected
const ext = JSON.parse(JSON.stringify(proposal));
ext.vizTx.extensions = [[0, {}]];
assert.throws(() => validateProposal(ext, { chainId: "viz-gateway", nowMs: 0 }), /extensions must be empty/);
console.log("[proposal] VG-01 multi-op / empty-ops / extensions rejection OK");

// merge round-trip: each operator signs the SAME tx independently; merged set
// must equal one-party-signs-all (order-independent), exactly like releases.
// Sign a clone with EMPTY signatures so the lone result IS this operator's
// partial. signTransaction does not guarantee append-at-end order (proven in
// viz-multisig-spike.cjs), so never index a partial out of an accumulated array.
function signWith(p, wif) {
  const fresh = { ...JSON.parse(JSON.stringify(p.vizTx)), signatures: [] };
  return viz.auth.signTransaction(fresh, [wif]).signatures[0];
}
let p = proposal;
p = addPartial(p, signWith(p, A.wif));
p = addPartial(p, signWith(p, B.wif));
assert.strictEqual(p.vizTx.signatures.length, 2);
const allAtOnce = viz.auth.signTransaction(
  JSON.parse(JSON.stringify(proposal.vizTx)),
  [A.wif, B.wif],
).signatures;
assert.strictEqual(
  [...p.vizTx.signatures].sort().join() === [...allAtOnce].sort().join(),
  true,
  "merged partials != all-at-once set",
);
// addPartial dedups an identical signature:
const before = p.vizTx.signatures.length;
p = addPartial(p, p.vizTx.signatures[0]);
assert.strictEqual(p.vizTx.signatures.length, before, "addPartial must dedup");
console.log("[proposal] independent-partial merge + dedup OK");

// --- co-sign contract: validate then addPartial accumulates across operators ---
{
  let pp = buildProposal({
    chainId: "viz-gateway", account: "viz-gateway",
    newOperators: newOps, newThreshold: 2, memoKey: MEMO, jsonMetadata: "{}",
    currentActiveHash: "x", taPoS,
  });
  for (const op of [A, B, C]) {
    validateProposal(pp, { chainId: "viz-gateway", nowMs: 0 });
    pp = addPartial(pp, signWith(pp, op.wif));
  }
  assert.strictEqual(pp.vizTx.signatures.length, 3);
  console.log("[co-sign] multi-operator accumulate OK");
}

// --- rotation state merge (shared by VIZ broadcast + TON tool) ---
{
  const s0 = { proposalFile: "rotation-proposal.json", vizDone: false, tonOrderAddress: "", tonDone: false, solanaNewMultisig: "", solanaDone: false };
  const s1 = mergeState(s0, { vizDone: true });
  assert.strictEqual(s1.vizDone, true);
  assert.strictEqual(s1.tonDone, false);
  const s2 = mergeState(s1, { tonOrderAddress: "EQabc", tonDone: false });
  assert.strictEqual(s2.tonOrderAddress, "EQabc");
  assert.strictEqual(s2.vizDone, true); // unchanged fields preserved
  const s3 = mergeState(s2, { tonDone: true });
  assert.strictEqual(s3.tonDone, true);
  const s4 = mergeState(s3, { solanaNewMultisig: "SoLms1", solanaDone: true });
  assert.strictEqual(s4.solanaNewMultisig, "SoLms1");
  assert.strictEqual(s4.solanaDone, true);
  assert.strictEqual(s4.tonDone, true); // unchanged fields preserved
  console.log("[state] mergeState preserves prior fields OK");
}

// --- 3-field operator spec carries solanaPubkey ---
const ops3 = parseOperators("op-1=VIZ1aaa:11aa:SoLpub1,op-2=VIZ1bbb:22bb:SoLpub2");
assert.strictEqual(ops3[0].solanaPubkey, "SoLpub1");
assert.strictEqual(ops3[1].solanaPubkey, "SoLpub2");
assert.strictEqual(serializeOperators(ops3), "op-1=VIZ1aaa:11aa:SoLpub1,op-2=VIZ1bbb:22bb:SoLpub2");

// --- a 2-field entry (no solanaPubkey) parses, defaulting solanaPubkey to "" ---
// (VIZ/TON-only rotations must not require a Solana key; matches parseManifest.)
const ops2 = parseOperators("op-1=VIZ1aaa:11aa,op-2=VIZ1bbb:22bb");
assert.strictEqual(ops2[0].solanaPubkey, "", "2-field entry defaults solanaPubkey to ''");
assert.strictEqual(serializeOperators(ops2), "op-1=VIZ1aaa:11aa,op-2=VIZ1bbb:22bb", "2-field round-trips");
// --- a 1-field rest (missing tonPubkey) is still rejected ---
assert.throws(() => parseOperators("op-1=VIZ1aaa"), /2 or 3 fields|incomplete/i);
console.log("[solana] 3-field spec carries solanaPubkey; 2-field optional + round-trips OK");

console.log("\nrotation-spike assertions passed.");
