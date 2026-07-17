// SPIKE/PROOF: TON on-chain M-of-N approval routing for wVIZ AUTO-RETURN (peg-out).
//
// Proves the supply-neutral jetton-transfer order path:
//   - A return (TEP-74 transfer 0x0f8a7ea5) order executes at EXACTLY the T-th approval.
//   - Supply is UNCHANGED throughout — no mint/burn, existing wVIZ is transferred.
//   - An outsider cannot approve (unauthorized_sign / count not raised).
//   - Gateway JW retains the fee slice; user JW receives NET.
//
// Models the live auto-return flow: gateway's JW (owned by multisig) holds peg-out
// deposits; upon detecting an unusable VIZ destination the coordinator builds a
// buildReturnTransfer order and routes it through the multisig threshold.
//
// Run (after `npm run build`):
//   node tools/gram-return-approval-spike.cjs
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Blockchain, createShardAccount } = require("@ton/sandbox");
const { Cell, Dictionary, beginCell, contractAddress, toNano } = require("@ton/core");
const { JettonMaster, JettonWallet } = require("@ton/ton");
const { Multisig, multisigConfigToCell } = require("../contracts/ton/dist/wrappers/Multisig.js");
const { Order } = require("../contracts/ton/dist/wrappers/Order.js");
// Use the same pure builder that production uses — proof never drifts from live code.
const { buildMintTransfer, buildReturnTransfer } = require("../packages/gram-watcher/dist/gramChain.js");

const BOC = path.join(__dirname, "..", "contracts", "ton", "boc");
const cell = (f) => Cell.fromBoc(readFileSync(path.join(BOC, f)))[0];

async function totalSupply(blockchain, minterAddr) {
  const master = blockchain.openContract(JettonMaster.create(minterAddr));
  const data = await master.getJettonData();
  return data.totalSupply;
}

async function getJettonWalletAddress(blockchain, minterAddr, ownerAddr) {
  const master = blockchain.openContract(JettonMaster.create(minterAddr));
  return master.getWalletAddress(ownerAddr);
}

async function jettonBalance(blockchain, minterAddr, ownerAddr) {
  const jwAddr = await getJettonWalletAddress(blockchain, minterAddr, ownerAddr);
  try {
    const jw = blockchain.openContract(JettonWallet.create(jwAddr));
    return await jw.getBalance();
  } catch {
    return 0n;
  }
}

(async () => {
  const blockchain = await Blockchain.create();
  const multisigCode = cell("multisig.code.boc");
  const minterCode = cell("minter.code.boc");
  const walletCode = cell("wallet.code.boc");
  const orderCode = cell("order.code.boc");

  // Register the order code as a library so TVM can resolve the hash reference used
  // by the multisig when deploying Order contracts (same setup as the mint spike).
  const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  libs.set(BigInt("0x" + orderCode.hash().toString("hex")), orderCode);
  blockchain.libs = beginCell().storeDictDirect(libs).endCell();

  // 5 independent operator wallets + a user (return recipient) + an outsider.
  const ops = [];
  for (let i = 0; i < 5; i++) ops.push(await blockchain.treasury(`op${i + 1}`));
  const user = await blockchain.treasury("user");
  const outsider = await blockchain.treasury("outsider"); // NOT in signer set
  const signers = ops.map((o) => o.address);
  const THRESHOLD = 3;

  // --- Install real 3-of-5 multisig ---
  const cfg = { threshold: THRESHOLD, signers, proposers: [], allowArbitrarySeqno: false };
  const multisigData = multisigConfigToCell(cfg);
  const multisigAddr = contractAddress(0, { code: multisigCode, data: multisigData });
  await blockchain.setShardAccount(
    multisigAddr,
    createShardAccount({ address: multisigAddr, code: multisigCode, data: multisigData, balance: toNano("100") }),
  );
  const multisig = blockchain.openContract(new Multisig(multisigAddr, undefined, cfg));

  // --- Install standard governed minter with admin = multisig ---
  const content = beginCell().storeUint(0, 8).endCell(); // onchain-content stub
  const minterData = beginCell()
    .storeCoins(0)
    .storeAddress(multisigAddr)
    .storeRef(content)
    .storeRef(walletCode)
    .endCell();
  const minterAddr = contractAddress(0, { code: minterCode, data: minterData });
  await blockchain.setShardAccount(
    minterAddr,
    createShardAccount({ address: minterAddr, code: minterCode, data: minterData, balance: toNano("10") }),
  );

  // Sanity: fresh 3-of-5 multisig + zero supply.
  const md = await multisig.getMultisigData();
  assert.strictEqual(Number(md.threshold), THRESHOLD, "threshold must be 3");
  assert.strictEqual(md.signers.length, 5, "must be 5 signers");
  assert.strictEqual(Number(md.nextOrderSeqno), 0, "first order seqno is 0");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), 0n, "supply starts at 0");
  console.log("[proof] installed real 3-of-5 multisig + minter (admin=multisig), supply=0");

  // =========================================================================
  // STEP 1: Mint DEPOSIT wVIZ to the gateway jetton wallet (owner = multisig).
  //
  // In production the gateway's JW holds the peg-out deposit (wVIZ burned from
  // the sender ends up as a HELD balance on gram.gate's JW, which is multisig-owned).
  // We model that here by minting DEPOSIT to the multisig address so the minter
  // creates a JW owned by the multisig — this IS the gateway JW.
  // =========================================================================
  const DEPOSIT = 100000n; // base units (milli-VIZ) — the peg-out deposit
  const FEE = 5000n;       // refundFeeMilliViz retained in gateway JW
  const NET = DEPOSIT - FEE; // what the user gets back

  // Seqno 0: mint DEPOSIT to multisig (= gateway JW).
  const mintOrderSeqno = md.nextOrderSeqno; // 0n
  const mintOrderAddr = await multisig.getOrderAddress(mintOrderSeqno);
  const mintTransfer = buildMintTransfer(minterAddr, multisigAddr, DEPOSIT);
  const expiration = Math.floor(Date.now() / 1000) + 3600;

  await multisig.sendNewOrder(ops[0].getSender(), [mintTransfer], expiration, toNano("1"));
  const mintOrder = blockchain.openContract(Order.createFromAddress(mintOrderAddr));
  await mintOrder.sendApprove(ops[1].getSender(), 1);
  await mintOrder.sendApprove(ops[2].getSender(), 2);

  const mintOd = await mintOrder.getOrderData();
  assert.strictEqual(mintOd.executed, true, "mint order must execute at 3/3");
  const supplyAfterMint = await totalSupply(blockchain, minterAddr);
  assert.strictEqual(supplyAfterMint, DEPOSIT, `supply after mint must be DEPOSIT (${DEPOSIT}), got ${supplyAfterMint}`);

  // Verify the gateway JW (owned by multisig) holds DEPOSIT.
  const gatewayJwBalance = await jettonBalance(blockchain, minterAddr, multisigAddr);
  assert.strictEqual(gatewayJwBalance, DEPOSIT, `gateway JW balance must be DEPOSIT (${DEPOSIT}), got ${gatewayJwBalance}`);
  console.log(`[proof] minted ${DEPOSIT} wVIZ to gateway JW (owner=multisig), supply=${DEPOSIT}   OK`);

  // Derive the gateway JW address (needed by buildReturnTransfer).
  const gatewayJwAddr = await getJettonWalletAddress(blockchain, minterAddr, multisigAddr);

  // =========================================================================
  // STEP 2: Open the return order (seqno 1).
  //
  // The coordinator calls buildReturnTransfer(gatewayJwAddr, user.address, NET)
  // and routes it through the multisig exactly as with mint — op1 opens (approve
  // on init), op2 and op3 approve to hit threshold.
  // =========================================================================
  const md2 = await multisig.getMultisigData();
  const returnOrderSeqno = md2.nextOrderSeqno; // 1n
  assert.strictEqual(Number(returnOrderSeqno), 1, "return order takes seqno 1");
  const returnOrderAddr = await multisig.getOrderAddress(returnOrderSeqno);

  // buildReturnTransfer value=0.1 TON covers: gateway JW compute gas + 0.05 forward
  // (deploys user JW if absent). PAY_GAS_SEPARATELY draws shortfall from multisig balance.
  const returnTransfer = buildReturnTransfer(gatewayJwAddr, user.address, NET);
  await multisig.sendNewOrder(ops[0].getSender(), [returnTransfer], expiration, toNano("1"));

  const returnOrder = blockchain.openContract(Order.createFromAddress(returnOrderAddr));
  let rod = await returnOrder.getOrderData();
  assert.ok(rod.inited, "return order must be inited after new_order");
  assert.strictEqual(rod.approvals_num, 1, "proposer approve_on_init counts as 1");
  assert.strictEqual(rod.executed, false, "must NOT execute at 1/3");
  // Supply must not change yet.
  assert.strictEqual(await totalSupply(blockchain, minterAddr), DEPOSIT, "supply unchanged at 1/3");
  console.log("[proof] new_order (return) by op1: approvals=1/3, executed=false, supply unchanged  OK");

  // --- op2 approves (2/3) ---
  await returnOrder.sendApprove(ops[1].getSender(), 1);
  rod = await returnOrder.getOrderData();
  assert.strictEqual(rod.approvals_num, 2, "op2 approval -> 2/3");
  assert.strictEqual(rod.executed, false, "must NOT execute at 2/3");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), DEPOSIT, "supply unchanged at 2/3");
  console.log("[proof] op2 approve: approvals=2/3, executed=false, supply unchanged              OK");

  // =========================================================================
  // STEP 3: Negative check — outsider cannot approve.
  // =========================================================================
  const supplyBefore = await totalSupply(blockchain, minterAddr);
  const bad = await returnOrder.sendApprove(outsider.getSender(), 4); // claim idx 4's slot
  const badFailed =
    bad.transactions.some((t) => (t.description?.computePhase?.exitCode ?? 0) !== 0) ||
    (await returnOrder.getOrderData()).approvals_num === 2;
  assert.ok(badFailed, "outsider approval must not be counted");
  assert.strictEqual((await returnOrder.getOrderData()).approvals_num, 2, "outsider did not raise the count");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), supplyBefore, "outsider caused no change");
  console.log("[proof] outsider approve rejected: still 2/3, supply unchanged                    OK");

  // =========================================================================
  // STEP 4: op3 approves -> 3/3 -> order EXECUTES -> jetton transfer lands.
  // =========================================================================
  await returnOrder.sendApprove(ops[2].getSender(), 2);
  rod = await returnOrder.getOrderData();
  assert.strictEqual(rod.executed, true, "must execute at 3/3");

  // Supply is UNCHANGED — this is a transfer, not a mint/burn.
  const supplyAfterReturn = await totalSupply(blockchain, minterAddr);
  assert.strictEqual(
    supplyAfterReturn,
    DEPOSIT,
    `supply must still be DEPOSIT (${DEPOSIT}) after return — supply-neutral, got ${supplyAfterReturn}`,
  );
  console.log(`[proof] op3 approve: executed=true, supply=${supplyAfterReturn} (=DEPOSIT, unchanged)  OK`);

  // User's JW balance must equal NET.
  const userBalance = await jettonBalance(blockchain, minterAddr, user.address);
  assert.strictEqual(
    userBalance,
    NET,
    `user JW balance must be NET (${NET}), got ${userBalance}`,
  );
  console.log(`[proof] user JW balance = ${userBalance} (=NET=${NET})                             OK`);

  // Gateway JW retains the fee slice (DEPOSIT - NET = FEE).
  const gatewayBalanceAfter = await jettonBalance(blockchain, minterAddr, multisigAddr);
  assert.strictEqual(
    gatewayBalanceAfter,
    DEPOSIT - NET,
    `gateway JW must retain fee (${DEPOSIT - NET}), got ${gatewayBalanceAfter}`,
  );
  console.log(`[proof] gateway JW retains fee = ${gatewayBalanceAfter} (=FEE=${FEE})              OK`);

  console.log("\n[proof] wVIZ auto-return via 3-of-5 multisig PROVEN (all assertions passed).");
})().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
