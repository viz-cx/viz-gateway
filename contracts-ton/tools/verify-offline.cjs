// Offline verification of the contract-deploy building blocks (no network, no
// code BOCs needed): wVIZ metadata round-trip, standard minter init data +
// deterministic address, change_admin body, and deployer wallet derivation.
//
// Run: node contracts-ton/tools/verify-offline.cjs
const assert = require("node:assert");
const { Address, beginCell } = require("@ton/core");
const { mnemonicNew } = require("@ton/crypto");
const {
  buildWvizContent,
  parseWvizContent,
  buildStandardMinterData,
  changeAdminBody,
  computeAddress,
  deriveDeployer,
  OP_CHANGE_ADMIN,
} = require("../dist/index.js");

(async () => {
  // 1. TEP-64 metadata round-trip
  const meta = {
    name: "Wrapped VIZ",
    symbol: "wVIZ",
    decimals: "3",
    description: "Bridge claim on VIZ. 1 wVIZ = 1 VIZ.",
  };
  const content = buildWvizContent(meta);
  const parsed = parseWvizContent(content);
  assert.strictEqual(parsed.name, meta.name);
  assert.strictEqual(parsed.symbol, meta.symbol);
  assert.strictEqual(parsed.decimals, meta.decimals);
  assert.strictEqual(parsed.description, meta.description);
  console.log(`[metadata] round-trip OK: ${parsed.symbol}, ${parsed.decimals} decimals`);

  // 2. Standard minter init data + deterministic address; parse data back
  const placeholderCode = beginCell().storeUint(0, 8).endCell();
  const admin = Address.parse("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs");
  const data = buildStandardMinterData(admin, content, placeholderCode);
  const addr = computeAddress(placeholderCode, data);
  const ds = data.beginParse();
  const supply = ds.loadCoins();
  const parsedAdmin = ds.loadAddress();
  assert.strictEqual(supply, 0n);
  assert.strictEqual(parsedAdmin.toString(), admin.toString());
  console.log(`[minter] data parses (supply=0, admin matches); address(placeholder code)=${addr.toString().slice(0, 12)}..`);

  // 3. change_admin body
  const body = changeAdminBody(admin);
  const bs = body.beginParse();
  assert.strictEqual(bs.loadUint(32), OP_CHANGE_ADMIN);
  bs.loadUintBig(64); // query_id
  assert.strictEqual(bs.loadAddress().toString(), admin.toString());
  console.log(`[change_admin] op=${OP_CHANGE_ADMIN}, new admin parses back OK`);

  // 4. deployer wallet derivation
  const words = await mnemonicNew();
  const { wallet } = await deriveDeployer(words.join(" "));
  assert.ok(wallet.address.toString().length > 0);
  console.log(`[wallet] derived deployer address: ${wallet.address.toString().slice(0, 12)}..`);

  console.log("\nRESULT: deploy building blocks verified offline. Deploy scripts need");
  console.log("only the compiled code BOCs (Blueprint) + a funded deployer to run live.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
