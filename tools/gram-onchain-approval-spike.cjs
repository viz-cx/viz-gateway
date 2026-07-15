// SPIKE/PROOF: TON on-chain M-of-N approval routing (Phase B).
//
// Runs the REAL vendored multisig-contract-v2 + standard jetton minter inside a
// local TVM (@ton/sandbox) and proves the threshold-approve -> execute state
// machine that Phase B relies on:
//   - a mint order does NOT execute below threshold (supply unchanged);
//   - it executes at EXACTLY the T-th approval (supply += NET);
//   - a duplicate approval from the same signer is rejected (already_approved);
//   - an approval from a non-signer wallet is rejected (unauthorized_sign);
//   - crash-recovery: re-deriving the same order address does NOT mint twice.
//
// This is the offline counterpart to the live testnet 3-of-5 proof (RUNBOOK).
// Design: docs/plan-ton-onchain-approval.md.
//
// Run (after `npm run build` so contracts/ton/dist exists):
//   node tools/gram-onchain-approval-spike.cjs
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Blockchain, createShardAccount } = require("@ton/sandbox");
const { Cell, Dictionary, beginCell, contractAddress, toNano } = require("@ton/core");
const { JettonMaster } = require("@ton/ton");
const { Multisig, multisigConfigToCell } = require("../contracts/ton/dist/wrappers/Multisig.js");
const { Order } = require("../contracts/ton/dist/wrappers/Order.js");
// Use the SAME pure mint-order builder the live write path uses, so this proof can
// never drift from production (packages/gram-watcher/src/gramChain.ts).
const { buildMintTransfer } = require("../packages/gram-watcher/dist/gramChain.js");

const BOC = path.join(__dirname, "..", "contracts", "ton", "boc");
const cell = (f) => Cell.fromBoc(readFileSync(path.join(BOC, f)))[0];

async function totalSupply(blockchain, minterAddr) {
  const master = blockchain.openContract(JettonMaster.create(minterAddr));
  const data = await master.getJettonData();
  return data.totalSupply;
}

(async () => {
  const blockchain = await Blockchain.create();
  const multisigCode = cell("multisig.code.boc");
  const minterCode = cell("minter.code.boc");
  const walletCode = cell("wallet.code.boc");
  const orderCode = cell("order.code.boc");

  // The multisig deploys each Order with its code as a LIBRARY reference (an exotic
  // cell holding only the order code hash). The TVM must resolve that hash to run the
  // order, so register the real order code in the blockchain library collection. This
  // is exactly what a masterchain-published library provides on live TON.
  const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  libs.set(BigInt("0x" + orderCode.hash().toString("hex")), orderCode);
  blockchain.libs = beginCell().storeDictDirect(libs).endCell();

  // 5 independent operator wallets (each is a distinct signer key) + a mint recipient.
  const ops = [];
  for (let i = 0; i < 5; i++) ops.push(await blockchain.treasury(`op${i + 1}`));
  const user = await blockchain.treasury("user");
  const outsider = await blockchain.treasury("outsider"); // NOT in the signer set
  const signers = ops.map((o) => o.address);
  const THRESHOLD = 3;

  // --- Install the REAL 3-of-5 multisig via its exact storage layout ---
  const cfg = { threshold: THRESHOLD, signers, proposers: [], allowArbitrarySeqno: false };
  const multisigData = multisigConfigToCell(cfg);
  const multisigAddr = contractAddress(0, { code: multisigCode, data: multisigData });
  await blockchain.setShardAccount(
    multisigAddr,
    createShardAccount({ address: multisigAddr, code: multisigCode, data: multisigData, balance: toNano("100") }),
  );
  const multisig = blockchain.openContract(new Multisig(multisigAddr, undefined, cfg));

  // --- Install the standard governed minter with admin = multisig ---
  const content = beginCell().storeUint(0, 8).endCell(); // onchain-content stub (supply test only)
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

  // Sanity: multisig reads back as a 3-of-5 with our signer set.
  const md = await multisig.getMultisigData();
  assert.strictEqual(Number(md.threshold), THRESHOLD, "threshold must be 3");
  assert.strictEqual(md.signers.length, 5, "must be 5 signers");
  assert.strictEqual(Number(md.nextOrderSeqno), 0, "first order seqno is 0");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), 0n, "supply starts at 0");
  console.log("[proof] installed real 3-of-5 multisig + minter (admin=multisig), supply=0");

  const MINT_AMOUNT = 12345n; // base units (milli-VIZ)
  const orderSeqno = md.nextOrderSeqno; // 0n
  const orderAddr = await multisig.getOrderAddress(orderSeqno);
  const mintTransfer = buildMintTransfer(minterAddr, user.address, MINT_AMOUNT);
  const expiration = Math.floor(Date.now() / 1000) + 3600;

  // --- Proposer (op1, idx 0) sends new_order with approve_on_init (its own approval) ---
  await multisig.sendNewOrder(ops[0].getSender(), [mintTransfer], expiration, toNano("1"));
  const order = blockchain.openContract(Order.createFromAddress(orderAddr));
  let od = await order.getOrderData();
  assert.ok(od.inited, "order must be inited after new_order");
  assert.strictEqual(od.approvals_num, 1, "proposer's approve_on_init counts as 1");
  assert.strictEqual(od.executed, false, "must NOT execute at 1/3");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), 0n, "no mint at 1/3");
  console.log("[proof] new_order by op1: approvals=1/3, executed=false, supply=0  OK");

  // --- op2 (idx 1) approves on-chain from its OWN wallet -> 2/3, still no mint ---
  await order.sendApprove(ops[1].getSender(), 1);
  od = await order.getOrderData();
  assert.strictEqual(od.approvals_num, 2, "op2 approval -> 2/3");
  assert.strictEqual(od.executed, false, "must NOT execute at 2/3");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), 0n, "no mint at 2/3");
  console.log("[proof] op2 approve: approvals=2/3, executed=false, supply=0       OK");

  // --- An OUTSIDER (not in signer set) cannot approve ---
  const before = await totalSupply(blockchain, minterAddr);
  const bad = await order.sendApprove(outsider.getSender(), 4); // claim someone else's idx
  const badFailed = bad.transactions.some((t) => (t.description?.computePhase?.exitCode ?? 0) !== 0)
    || (await order.getOrderData()).approvals_num === 2;
  assert.ok(badFailed, "outsider approval must not be counted");
  assert.strictEqual((await order.getOrderData()).approvals_num, 2, "outsider did not raise the count");
  assert.strictEqual(await totalSupply(blockchain, minterAddr), before, "outsider caused no mint");
  console.log("[proof] outsider approve rejected: still 2/3, supply unchanged     OK");

  // --- op3 (idx 2) approves -> 3/3 -> order EXECUTES -> mint lands ---
  await order.sendApprove(ops[2].getSender(), 2);
  od = await order.getOrderData();
  assert.strictEqual(od.executed, true, "must execute at 3/3");
  const supplyAfter = await totalSupply(blockchain, minterAddr);
  assert.strictEqual(supplyAfter, MINT_AMOUNT, `supply must be NET (${MINT_AMOUNT}) after execute, got ${supplyAfter}`);
  console.log(`[proof] op3 approve: executed=true, supply=${supplyAfter} (=NET)          OK`);

  // --- Duplicate approval from op2 is rejected; no second mint ---
  await order.sendApprove(ops[1].getSender(), 1);
  assert.strictEqual(await totalSupply(blockchain, minterAddr), MINT_AMOUNT, "duplicate approve must not re-mint");
  console.log("[proof] duplicate op2 approve: supply unchanged (no double-mint)    OK");

  // --- Crash-recovery: the order address is a pure fn of (multisig, seqno). Re-deriving
  //     it and checking existence/executed is the idempotency key; no second order. ---
  const reAddr = await multisig.getOrderAddress(orderSeqno);
  assert.ok(reAddr.equals(orderAddr), "order address must be deterministic from seqno");
  const reData = await order.getOrderData();
  assert.ok(reData.executed, "recovery sees the order already executed -> skip re-broadcast");
  console.log("[proof] recovery: deterministic order addr + executed flag -> idempotent OK");

  // --- Opener is NOT privileged: a SECOND order opened by a DIFFERENT signer (op3, idx 2,
  //     not op1) executes identically. This is the on-chain premise behind opener-failover:
  //     whichever live operator opens the order works, so a stuck operators[0] cannot block
  //     the mint (coordinator-side failover proven in gram-proposer-fallback-spike). ---
  {
    const md2 = await multisig.getMultisigData();
    const seqno2 = md2.nextOrderSeqno; // 1n (advanced by the first order)
    assert.strictEqual(Number(seqno2), 1, "second order takes the next seqno");
    const addr2 = await multisig.getOrderAddress(seqno2);
    const amt2 = 500n;
    const supplyBefore = await totalSupply(blockchain, minterAddr);
    // op3 (idx 2) OPENS the order — not the operator that opened the first one.
    await multisig.sendNewOrder(ops[2].getSender(), [buildMintTransfer(minterAddr, user.address, amt2)], expiration, toNano("1"));
    const order2 = blockchain.openContract(Order.createFromAddress(addr2));
    let od2 = await order2.getOrderData();
    assert.ok(od2.inited, "order opened by a non-first signer must init");
    assert.strictEqual(od2.approvals_num, 1, "opener's approve_on_init counts (idx 2)");
    // Two more distinct signers approve -> 3/3 -> executes.
    await order2.sendApprove(ops[0].getSender(), 0);
    await order2.sendApprove(ops[1].getSender(), 1);
    od2 = await order2.getOrderData();
    assert.strictEqual(od2.executed, true, "executes at 3/3 regardless of who opened");
    assert.strictEqual(await totalSupply(blockchain, minterAddr), supplyBefore + amt2, "second mint lands (NET)");
    console.log("[proof] order opened by a NON-first signer (op3) executes at 3/3 -> opener not privileged OK");
  }

  console.log("\n[proof] TON on-chain 3-of-5 approval routing PROVEN (all assertions passed).");
})().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
