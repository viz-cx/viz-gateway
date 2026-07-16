// SPIKE: prove the bridge app's peg-out payload is exactly what gram-watcher accepts.
// Builds the transfer body via site/pegout.mjs, extracts its forward_payload, wraps it
// as the internal_transfer (0x178d4519) the gateway jetton wallet actually receives,
// and asserts parseJettonDeposit recovers the comment (VIZ account) + amount.
//
// Run: node tools/wviz-app-payload-spike.cjs
const assert = require("node:assert");
const { beginCell, Address } = require("@ton/ton");
const { parseJettonDeposit } = require("../packages/gram-watcher/dist/gramChain.js");

const OWNER = "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0"; // gateway multisig
const SENDER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"; // an arbitrary user
const AMOUNT = 1068237n; // base units (1068.237 wVIZ at 3 decimals)
const COMMENT = "alice"; // the user's VIZ destination account

(async () => {
  const { buildPegoutBody, wvizToBaseUnits, isValidVizAccount, computePegInFee } = await import("../site/pegout.mjs");

  // sanity: amount + validator helpers
  assert.strictEqual(wvizToBaseUnits("1068.237"), AMOUNT);
  assert.ok(isValidVizAccount("alice") && isValidVizAccount("gram.gate") && isValidVizAccount("id"));
  assert.ok(!isValidVizAccount("Alice") && !isValidVizAccount("a") && !isValidVizAccount("x-"));
  const fee = computePegInFee({ grossMilliViz: 1000000n, floorMilliViz: 10000n, bps: 20, activationSurchargeMilliViz: 10000n, walletDeployed: false });
  assert.strictEqual(fee.total, 20000n); // max(10, 0.2% of 1000)=10 + 10 activation = 20 VIZ

  // build the exact app transfer body
  const body = buildPegoutBody(
    { beginCell, Address },
    { amountBaseUnits: AMOUNT, destinationOwner: OWNER, responseAddress: SENDER, forwardTonAmount: 50000000n, vizRecipient: COMMENT },
  );

  // parse the transfer body to pull out its forward_payload ref (the comment cell)
  const s = body.beginParse();
  s.loadUint(32); // op 0x0f8a7ea5
  s.loadUintBig(64); // query_id
  s.loadCoins(); // amount
  s.loadAddress(); // destination
  s.loadAddress(); // response
  s.loadBit(); // custom payload bit (false)
  s.loadCoins(); // forward_ton_amount
  const inRef = s.loadBit();
  assert.ok(inRef, "forward_payload should be in a ref");
  const commentCell = s.loadRef();

  // reconstruct the internal_transfer the gateway jetton wallet receives, embedding
  // the SAME forward_payload, then run the watcher's parser over it.
  const inbound = beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(0n, 64)
    .storeCoins(AMOUNT)
    .storeAddress(Address.parse(SENDER)) // from
    .storeAddress(Address.parse(SENDER)) // response_address
    .storeCoins(50000000n) // forward_ton_amount
    .storeBit(true)
    .storeRef(commentCell)
    .endCell();

  const p = parseJettonDeposit(inbound.beginParse());
  assert.ok(p, "parser returned null");
  assert.strictEqual(p.amountBaseUnits, AMOUNT, "amount");
  assert.strictEqual(p.comment, COMMENT, "comment");
  console.log(`OK amount=${p.amountBaseUnits} comment="${p.comment}" — app payload is watcher-compatible`);
})().catch((e) => { console.error(e); process.exit(1); });
