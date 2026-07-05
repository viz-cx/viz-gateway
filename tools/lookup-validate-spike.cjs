// SPIKE: deposit-address lookup request resolution (offline).
// Peg-out Variant A: GET /address?viz_account=alice issues (and registers) a
// deterministic Solana deposit address. Before issuing, the request passes a
// cheap format pre-filter and then the REAL gate: on-chain VIZ account
// existence. wVIZ sent to a deposit address for a typo'd/non-existent VIZ
// account would be burned on release with no valid target and no refund
// (peg-out never refunds) -> stuck funds; so a non-existent account must never
// be issued an address, and a VIZ-node outage must fail closed (no unverified
// issue). Verifies the pure resolver in lookupValidate.ts.
//
// Run: node tools/lookup-validate-spike.cjs   (after npm run build)
const assert = require("node:assert");
const {
  VIZ_ACCOUNT_RE,
  MAX_VIZ_ACCOUNT_BYTES,
  normalizeVizAccount,
  resolveDepositAddress,
} = require("../packages/solana-watcher/dist/lookupValidate");

// 1) Format pre-filter: charset + length bounds (len 2..32, leading letter).
const FORMAT_CASES = [
  ["id", true], // 2 chars = minimum; leading letter + one more -> PASSES the pre-filter
  ["a", false], // 1 char -> too short
  ["ab", true],
  ["alice", true],
  ["viz-gateway", true],
  ["a.sub", true],
  ["Alice", false], // uppercase not allowed
  ["1bob", false], // must start with a letter
  ["--", false], // must start with a letter
  ["bad name", false], // space not in charset
  ["x".repeat(32), true], // 32 = max
  ["x".repeat(33), false], // 33 -> too long
];
for (const [name, ok] of FORMAT_CASES) {
  assert.strictEqual(VIZ_ACCOUNT_RE.test(name), ok, `regex ${JSON.stringify(name)} => ${ok}`);
}
console.log("[lookup] format pre-filter charset/length bounds OK ('id' passes as the 2-char minimum)");

// 2) normalizeVizAccount trims + lowercases before the format check.
assert.strictEqual(normalizeVizAccount("  Alice  "), "alice"); // trimmed + lowercased -> valid
assert.strictEqual(normalizeVizAccount("ALICE"), "alice");
assert.strictEqual(normalizeVizAccount("a"), null); // still too short after normalize
assert.strictEqual(normalizeVizAccount(null), null);
assert.strictEqual(normalizeVizAccount(undefined), null);
assert.strictEqual(normalizeVizAccount(""), null);
console.log("[lookup] normalize trims/lowercases then format-checks OK");

// Deterministic fake derivation for the resolver deps.
const deps = (accountExists) => ({
  accountExists,
  depositAddress: (name) => `addr:${name}`,
  depositAta: (name) => `ata:${name}`,
});
const existsFor = (set) => async (name) => set.has(name);

(async () => {
  // 3) Malformed shape (passes regex) is still killed by the existence gate, not issued.
  //    "id" and "a.sub" clear the pre-filter but don't exist on VIZ -> 404, never derived.
  let derived = false;
  const trackDeriv = {
    accountExists: existsFor(new Set()), // nothing exists
    depositAddress: (n) => { derived = true; return `addr:${n}`; },
    depositAta: (n) => `ata:${n}`,
  };
  for (const junk of ["id", "a.sub", "a..b", "typo-account"]) {
    const r = await resolveDepositAddress(junk, trackDeriv);
    assert.strictEqual(r.status, 404, `${junk} should 404 (not on chain)`);
  }
  assert.strictEqual(derived, false, "no address derived for non-existent accounts");
  console.log("[lookup] non-existent accounts (incl. 'id') -> 404, no address derived OK");

  // 4) Bad format short-circuits BEFORE any RPC (accountExists must not be called).
  let rpcCalls = 0;
  const countRpc = {
    accountExists: async () => { rpcCalls++; return true; },
    depositAddress: (n) => `addr:${n}`,
    depositAta: (n) => `ata:${n}`,
  };
  const bad = await resolveDepositAddress("1bob", countRpc);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(rpcCalls, 0, "format reject must not hit the VIZ node");
  console.log("[lookup] invalid format -> 400 with zero RPC calls OK");

  // 5) Existing account -> 200 with derived address/ata bound to the normalized name.
  const ok = await resolveDepositAddress("  Alice  ", deps(existsFor(new Set(["alice"]))));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.vizAccount, "alice"); // normalized
  assert.strictEqual(ok.address, "addr:alice");
  assert.strictEqual(ok.ata, "ata:alice");
  console.log("[lookup] existing account -> 200, address/ata bound to normalized name OK");

  // 6) VIZ node outage (accountExists throws) propagates -> caller fails closed (500).
  await assert.rejects(
    () => resolveDepositAddress("alice", { ...deps(existsFor(new Set())), accountExists: async () => { throw new Error("node down"); } }),
    /node down/,
    "existence-check failure must propagate, not silently issue",
  );
  console.log("[lookup] VIZ node outage propagates (fail closed) OK");

  // 7) Over-length names (regex allows up to 32; on-chain program guards <= 16 bytes) are
  //    rejected at issuance BEFORE the RPC, so a deposit address whose release burn would
  //    revert on-chain (AccountNameTooLong) and strand funds is never handed out.
  assert.strictEqual(MAX_VIZ_ACCOUNT_BYTES, 16, "guard must mirror the on-chain limit");
  const sixteen = "a".repeat(16); // exactly at the limit -> allowed (if it exists)
  const seventeen = "a".repeat(17); // 1 over -> rejected at issuance
  let overLenRpc = 0;
  const overLenDeps = {
    accountExists: async () => { overLenRpc++; return true; }, // would "exist", but must never be reached
    depositAddress: (n) => `addr:${n}`,
    depositAta: (n) => `ata:${n}`,
  };
  const over = await resolveDepositAddress(seventeen, overLenDeps);
  assert.strictEqual(over.status, 400, "17-byte name must be rejected (over on-chain limit)");
  assert.match(over.body.error, /exceeds 16 bytes/, "clear over-length error");
  assert.strictEqual(overLenRpc, 0, "over-length reject must not hit the VIZ node");
  const atLimit = await resolveDepositAddress(sixteen, {
    accountExists: async () => true,
    depositAddress: (n) => `addr:${n}`,
    depositAta: (n) => `ata:${n}`,
  });
  assert.strictEqual(atLimit.status, 200, "16-byte name (at the limit) is issuable");
  console.log("[lookup] >16-byte names rejected at issuance (zero RPC); 16-byte boundary allowed OK");

  console.log("\nRESULT: lookup gates issuance on VIZ account existence; format is a\n" +
    "cheap pre-filter (zero RPC on reject); malformed-but-regex-valid names ('id',\n" +
    "'a.sub') are caught by the on-chain gate; >16-byte names are rejected at\n" +
    "issuance (consistent with the burn-only program); node outage fails closed.");
})();
