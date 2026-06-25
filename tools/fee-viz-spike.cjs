// SPIKE: peg-in fee on the VIZ side (offline, pure). Decision: fee held in VIZ,
// base = max(10 VIZ, 0.20%), + per-chain activation surcharge when the destination
// is not provisioned; mint NET (gross − fee); reject (refund) if net can't cover
// the mint-gas floor. base is a pure function of GROSS -> every operator derives
// the same value independently; activation rides a pinned flag.
//
// Run: node tools/fee-viz-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { quotePegIn, baseFee } = require("../packages/common/dist/fees");

const VIZ = (n) => BigInt(n) * 1000n; // VIZ -> milli-VIZ
const P = {
  floorMilliViz: VIZ(10), // 10 VIZ floor
  bps: 20, // 0.20%
  activationSurchargeMilliViz: VIZ(10), // +10 VIZ if destination not provisioned
  mintGasFloorMilliViz: VIZ(1), // net must clear 1 VIZ
};

// base = max(floor, bps%): floor dominates below 5,000 VIZ, then 0.2%.
assert.strictEqual(baseFee(VIZ(1000), P), VIZ(10)); // 0.2% = 2 -> floor 10
assert.strictEqual(baseFee(VIZ(5000), P), VIZ(10)); // crossover: 0.2% = 10 = floor
assert.strictEqual(baseFee(VIZ(10000), P), VIZ(20)); // 0.2% = 20
assert.strictEqual(baseFee(VIZ(100000), P), VIZ(200)); // 0.2% = 200
console.log("[fee] base = max(10 VIZ, 0.20%); crossover at 5,000 VIZ OK");

// 10,000 VIZ, destination already provisioned -> fee 20, net 9,980.
let q = quotePegIn(VIZ(10000), true, P);
assert.ok(q.ok && q.b.base === VIZ(20) && q.b.activation === 0n && q.b.net === VIZ(9980));
console.log(`[fee] 10,000 VIZ provisioned -> fee ${q.b.fee / 1000n} net ${q.b.net / 1000n} VIZ OK`);

// 10,000 VIZ, destination NOT provisioned -> +10 activation -> fee 30, net 9,970.
q = quotePegIn(VIZ(10000), false, P);
assert.ok(q.ok && q.b.activation === VIZ(10) && q.b.fee === VIZ(30) && q.b.net === VIZ(9970));
console.log(`[fee] 10,000 VIZ unprovisioned -> +activation, fee ${q.b.fee / 1000n} net ${q.b.net / 1000n} VIZ OK`);

// net + fee == gross (no value created or lost).
assert.strictEqual(q.b.net + q.b.fee, VIZ(10000));
console.log("[fee] net + fee == gross OK");

// dust below the fee -> rejected for refund (no fixed MIN_PEGIN).
q = quotePegIn(VIZ(5), true, P); // base 10 VIZ > 5 VIZ gross
assert.ok(!q.ok && q.reason === "BELOW_MIN");
console.log("[fee] deposit below fee -> BELOW_MIN (refund) OK");

// determinism: same inputs -> identical base across "operators".
assert.strictEqual(baseFee(VIZ(73421), P), baseFee(VIZ(73421), P));
console.log("[fee] base deterministic from gross OK");

console.log("\nRESULT: VIZ-side peg-in fee (base + pinned activation, mint net) verified.");
