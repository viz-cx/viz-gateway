// SPIKE/TEST: TON rotation core — deterministic signer-address derivation,
// update-action/order cell building, order validation vs proposal, signer-set
// hash. Pure/offline (no network); uses the vendored multisig-v2 wrappers.
//
// Run (after `npm run build`): node tools/gram-rotation-spike.cjs
const assert = require("node:assert");
const { mnemonicToPrivateKey } = require("@ton/crypto");
const { Address } = require("@ton/core");
const {
  tonSignerAddress,
  buildUpdateAction,
  packRotationOrder,
  validateTonOrder,
  tonSignerSetHash,
  sameSignerSet,
} = require("../contracts/ton/dist/tonRotation.js");

(async () => {
  // Two deterministic operator keypairs from fixed mnemonics.
  const m1 = ("abandon ".repeat(23) + "art").trim().split(" ");
  const m2 = ("abandon ".repeat(22) + "about absurd").trim().split(" "); // any valid-length list
  const kp1 = await mnemonicToPrivateKey(m1);
  const kp2 = await mnemonicToPrivateKey(m2);
  const pub1 = kp1.publicKey.toString("hex");
  const pub2 = kp2.publicKey.toString("hex");

  // --- address derivation is deterministic + matches WalletV4(workchain 0) ---
  const a1 = tonSignerAddress(pub1);
  const a1b = tonSignerAddress(pub1);
  assert.ok(a1 instanceof Address);
  assert.strictEqual(a1.toString(), a1b.toString(), "address derivation must be deterministic");
  console.log("[ton] signer address derivation OK:", a1.toString());

  const operators = [
    { id: "op-1", vizPubkey: "VIZ1a", tonPubkey: pub1 },
    { id: "op-2", vizPubkey: "VIZ1b", tonPubkey: pub2 },
  ];

  // --- update action + packed order are deterministic ---
  const order1 = packRotationOrder(operators, 2);
  const order2 = packRotationOrder(operators, 2);
  assert.ok(order1.equals(order2), "packed order must be deterministic");
  console.log("[ton] packRotationOrder deterministic OK");

  // --- validateTonOrder accepts a faithful order, rejects a tampered one ---
  const proposal = { version: 1, chainId: "viz-gateway", newOperators: operators, newThreshold: 2 };
  validateTonOrder(order1, proposal); // no throw
  // tamper: different threshold -> different packed cell -> rejected
  const tampered = packRotationOrder(operators, 1);
  assert.throws(() => validateTonOrder(tampered, proposal), /does not match/);
  console.log("[ton] validateTonOrder accept + tamper-reject OK");

  // --- signer-set hash + sameSignerSet are order-independent ---
  const h1 = tonSignerSetHash([a1, tonSignerAddress(pub2)], 2);
  const h2 = tonSignerSetHash([tonSignerAddress(pub2), a1], 2);
  assert.strictEqual(h1, h2, "signer-set hash must be order-independent");
  assert.strictEqual(sameSignerSet([a1, tonSignerAddress(pub2)], [tonSignerAddress(pub2), a1]), true);
  assert.strictEqual(sameSignerSet([a1], [a1, tonSignerAddress(pub2)]), false);
  console.log("[ton] signer-set hash + sameSignerSet OK");

  // --- duplicate tonPubkey guard ---
  assert.throws(
    () => packRotationOrder([
      { id: "op-1", vizPubkey: "V1", tonPubkey: pub1 },
      { id: "op-2", vizPubkey: "V2", tonPubkey: pub1 }, // same pubkey
    ], 1),
    /duplicate tonPubkey/
  );
  console.log("[ton] duplicate tonPubkey guard OK");

  console.log("\nton-rotation-spike assertions passed.");
})().catch((e) => { console.error(e); process.exit(1); });
