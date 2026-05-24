// SPIKE: peg-in fee + minimum economics (offline). Verifies quotePegIn against
// the configured defaults at 1 VIZ=$0.005, 1 TON=$2.
//   floor 100 VIZ, 0.30%, min 2,000 VIZ.   (amounts in milli-VIZ)
//
// Run: node tools/fees-spike.cjs
const assert = require("node:assert");
const { quotePegIn } = require("@gateway/common");

const P = { flatFloorMilliViz: 100_000n, bps: 30, minPegInMilliViz: 2_000_000n };
const VIZ = (n) => BigInt(n) * 1000n; // VIZ -> milli-VIZ

// below the 2,000 VIZ minimum -> rejected
let q = quotePegIn(VIZ(1999), P);
assert.strictEqual(q.ok, false);
assert.strictEqual(q.reason, "BELOW_MIN");
console.log("[min] 1,999 VIZ rejected (below 2,000 VIZ minimum) OK");

// exactly at the minimum: flat floor dominates -> fee 100 VIZ, net 1,900 VIZ
q = quotePegIn(VIZ(2000), P);
assert.ok(q.ok && q.fee === VIZ(100) && q.net === VIZ(1900));
console.log(`[2,000 VIZ] fee=${q.fee / 1000n} VIZ net=${q.net / 1000n} VIZ (rate 5%) OK`);

// 10,000 VIZ: floor still dominates (0.3% = 30 VIZ < 100)
q = quotePegIn(VIZ(10000), P);
assert.ok(q.ok && q.fee === VIZ(100));
console.log(`[10,000 VIZ] fee=${q.fee / 1000n} VIZ (rate 1%) OK`);

// ~33,333 VIZ crossover: 0.3% (~99.999 VIZ) still <= floor
q = quotePegIn(VIZ(33333), P);
assert.ok(q.ok && q.fee === VIZ(100));
console.log("[33,333 VIZ] floor and 0.3% meet (~100 VIZ) OK");

// 100,000 VIZ: 0.3% = 300 VIZ overtakes the floor
q = quotePegIn(VIZ(100000), P);
assert.ok(q.ok && q.fee === VIZ(300) && q.net === VIZ(99700));
console.log(`[100,000 VIZ] fee=${q.fee / 1000n} VIZ net=${q.net / 1000n} VIZ (rate 0.30%) OK`);

console.log("\nRESULT: peg-in fee = max(100 VIZ, 0.30%); below 2,000 VIZ rejected.");
console.log("Per peg the gateway collects >= ~$0.50 vs <= ~$0.20 mint gas -> sustainable.");
