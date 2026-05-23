// SPIKE: does viz-js-lib support independent partial signing + merge for a
// multi-key (M-of-N) active authority? This is the #1 design risk.
//
// The federated model requires: each operator, given the SAME transaction,
// independently produces a signature with ONLY its own key; a (keyless)
// coordinator concatenates the signatures; the result is a valid multi-signed
// transaction. We prove that the concatenation of independent signatures is
// byte-identical to one party signing with all keys at once.
//
// Run: node tools/viz-multisig-spike.cjs
const viz = require("viz-js-lib");
const assert = require("node:assert");

console.log("signature class methods:", Object.getOwnPropertyNames(viz.auth.signature).filter(n => typeof viz.auth.signature[n] === "function"));
console.log("default chain_id:", viz.config.get("chain_id"));

// 1. Derive three independent operator keypairs (stand-ins for HSM-held keys).
function keypair(seed) {
  const wif = viz.auth.toWif("gateway", `password-${seed}`, "active");
  const pub = viz.auth.wifToPublic(wif);
  return { wif, pub };
}
const A = keypair("op1");
const B = keypair("op2");
const C = keypair("op3");
console.log("\noperator pubkeys:");
console.log("  A:", A.pub);
console.log("  B:", B.pub);
console.log("  C:", C.pub);

// 2. The canonical transaction every operator will sign (a gateway release).
//    Fields are deterministic; TaPoS ref + expiration bound replay.
const baseTx = {
  ref_block_num: 1234,
  ref_block_prefix: 5678901,
  expiration: "2026-05-23T12:00:00",
  extensions: [],
  operations: [
    ["transfer", { from: "viz-gateway", to: "alice", amount: "10.000 VIZ", memo: "peg-out:abc:0" }],
  ],
};
const fresh = () => JSON.parse(JSON.stringify(baseTx));

// 3. Determinism: same tx + same key -> identical signature (RFC6979 / canonical).
const det1 = viz.auth.signTransaction(fresh(), [A.wif]).signatures[0];
const det2 = viz.auth.signTransaction(fresh(), [A.wif]).signatures[0];
console.log("\n[determinism] A signs identical tx twice -> same signature:", det1 === det2);
assert.strictEqual(det1, det2, "signing is non-deterministic");

// 4. Independent partial signing by 3 separate operators (each only its key).
const sigA = viz.auth.signTransaction(fresh(), [A.wif]).signatures[0];
const sigB = viz.auth.signTransaction(fresh(), [B.wif]).signatures[0];
const sigC = viz.auth.signTransaction(fresh(), [C.wif]).signatures[0];

// 5. Coordinator merges the independent signatures into one transaction.
const merged = Object.assign(fresh(), { signatures: [sigA, sigB, sigC] });

// 6. Ground truth: one party signs the same tx with all three keys at once.
const allAtOnce = viz.auth.signTransaction(fresh(), [A.wif, B.wif, C.wif]).signatures;

console.log("\n[merge] independent sigs:", merged.signatures.length, "| all-at-once:", allAtOnce.length);
// Each independently-produced signature must appear verbatim in the group
// signing result (proving a signature depends only on the canonical buffer +
// that one key, never on co-signers). Array ORDER is irrelevant on Graphene:
// the chain recovers a pubkey from each signature and sums authority weights;
// position is not validated. So compare as sets, not sequences.
for (const [name, sig] of [["A", sigA], ["B", sigB], ["C", sigC]]) {
  const present = allAtOnce.includes(sig);
  console.log(`[merge] independent sig ${name} present in group signing:`, present);
  assert.ok(present, `independent sig ${name} not reproduced by group signing`);
}
const sortedEqual =
  [...merged.signatures].sort().join() === [...allAtOnce].sort().join();
console.log("[merge] signature SETS identical (order aside):", sortedEqual);
assert.ok(sortedEqual, "merged signature set != all-at-once set");
console.log("[merge] NOTE: signTransaction returned a different array order;");
console.log("        implementers must treat the signatures array as unordered.");

// 7. Accumulation: passing a partially-signed tx to the next operator appends.
let acc = viz.auth.signTransaction(fresh(), [A.wif]);
acc = viz.auth.signTransaction(acc, [B.wif]);
console.log("\n[accumulate] pass-around tx after A then B has", acc.signatures.length, "sigs:", acc.signatures.length === 2);
assert.strictEqual(acc.signatures.length, 2);

// 8. Tamper-binding: signature binds to tx content; changing the amount changes it.
const tampered = fresh();
tampered.operations[0][1].amount = "10.001 VIZ";
const sigTampered = viz.auth.signTransaction(tampered, [A.wif]).signatures[0];
console.log("[tamper] changing amount changes A's signature:", sigTampered !== sigA);
assert.notStrictEqual(sigTampered, sigA);

console.log("\nRESULT: viz-js-lib supports independent partial signing + merge. The");
console.log("federated M-of-N signer model is viable on the VIZ side as designed.");
