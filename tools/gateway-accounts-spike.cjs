// SPIKE: GatewayAccounts registry contracts + per-network recon isolation.
//
// Proves:
//   1) Registry rejects a shared account (injectivity) and a missing chain (totality).
//   2) chainFor throws on an unmapped (stranger) account.
//   3) Per-network recon detects under-backing on one chain while the other has surplus —
//      the isolation property. A single aggregate recon would net to "healthy" and miss it.
//
// Run (after `npm run build`): node tools/gateway-accounts-spike.cjs
const assert = require("node:assert");
const { GatewayAccounts, InMemoryGatewayStore } = require("@gateway/common");
const { Recon } = require("../packages/recon/dist/checker.js");

let failures = 0;
const ok = (msg) => console.log(`[PASS] ${msg}`);
const bad = (msg) => { console.error(`[FAIL] ${msg}`); failures++; };

// ---- 1. Registry contracts ---------------------------------------------------

// Totality: every account entry must be non-empty.
try {
  // Empty account string → should throw (chain is declared but account is unset)
  new GatewayAccounts({ GRAM: "", SOLANA: "solana.gate" });
  bad("empty account should throw");
} catch (e) {
  ok(`totality: empty account rejected (${e.message.split("\n")[0]})`);
}

// Injectivity: two chains cannot share the same backing account.
try {
  new GatewayAccounts({ GRAM: "shared.gate", SOLANA: "shared.gate" });
  bad("shared backing account should throw");
} catch (e) {
  ok(`injectivity: shared account rejected (${e.message.split("\n")[0]})`);
}

// Valid registry: two distinct accounts.
const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });
assert.strictEqual(accounts.accountFor("GRAM"), "gram.gate");
assert.strictEqual(accounts.accountFor("SOLANA"), "solana.gate");
assert.strictEqual(accounts.chainFor("gram.gate"), "GRAM");
assert.strictEqual(accounts.chainFor("solana.gate"), "SOLANA");
assert.ok(accounts.isBackingAccount("gram.gate"));
assert.ok(!accounts.isBackingAccount("stranger.gate"));
ok("valid registry: accountFor/chainFor/isBackingAccount correct");

// ---- 2. chainFor throws on stranger -----------------------------------------

try {
  accounts.chainFor("stranger.gate");
  bad("chainFor stranger should throw");
} catch (e) {
  ok(`chainFor: stranger account rejected (${e.message.split("\n")[0]})`);
}

// ---- 3. Per-network recon isolation -----------------------------------------
// SOLANA: locked=100, circulating=50 → surplus (+50, OK)
// GRAM:   locked=10,  circulating=40 → under-backed (-30, FAIL)
//
// Aggregate view: total locked=110, total circulating=90 → drift=+20 → "healthy" (WRONG).
// Per-chain view: GRAM check detects under-backing → pause.

(async () => {
  const store = new InMemoryGatewayStore();
  const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

  const solanaRecon = new Recon(
    [{ name: "SOLANA", supply: async () => 50n }],
    async () => 100n,
    store,
    cfg,
    "SOLANA",
  );
  const gramRecon = new Recon(
    [{ name: "GRAM", supply: async () => 40n }],
    async () => 10n,
    store,
    cfg,
    "GRAM",
  );

  const solResult = await solanaRecon.check();
  assert.strictEqual(solResult, true, "SOLANA should be healthy (surplus)");
  assert.strictEqual(await store.isPaused(), false, "no pause yet after SOLANA check");
  ok("SOLANA surplus: check=true, not paused");

  const gramResult = await gramRecon.check();
  assert.strictEqual(gramResult, false, "GRAM should detect under-backing");
  assert.ok(await store.isPaused(), "gateway must be paused after GRAM under-backing");
  ok("GRAM under-backed: check=false, gateway paused (isolation detected)");

  // Confirm: an aggregate (non-isolated) check would see healthy drift (+20) and miss it.
  const aggregateLocked = 100n + 10n;   // 110
  const aggregateCirculating = 50n + 40n; // 90
  const aggregateDrift = aggregateLocked - aggregateCirculating; // +20 (looks fine)
  assert.ok(aggregateDrift > 0n, "aggregate drift is positive (would mask GRAM under-backing)");
  ok(`aggregate check would report drift=+${aggregateDrift} mVIZ (false healthy) — isolation PROVEN`);

  if (failures > 0) {
    console.error(`\nRESULT: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nRESULT: GatewayAccounts registry enforces injectivity + totality; per-network recon");
  console.log("detects GRAM under-backing that aggregate recon would mask.");
})().catch((e) => { console.error(e); process.exit(1); });
