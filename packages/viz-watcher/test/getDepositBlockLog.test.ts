import { test } from "node:test";
import assert from "node:assert/strict";
import viz from "viz-js-lib";
import { GatewayAccounts } from "@gateway/common";
import { VizJsChain, computeTrxId } from "../src/vizChain";

// The F2 block-log fallback: when operation_history has PRUNED a parent PEG_IN's block, getDeposit
// re-reads it from the raw block LOG (database_api.get_block) and RECOMPUTES the graphene trx id to
// bind it trustlessly. Lock: the golden-vector id, the pruned->fallback path, hint-gating, cross-node
// rotation on an empty/pruned block, the irreversibility gate, and that a lying hint fails closed.

const accounts = new GatewayAccounts({ GRAM: "gram.gate", SOLANA: "solana.gate" });

// The incident transaction (kristi's 100 VIZ -> gram.gate), captured from api.viz.world block
// 81976371. computeTrxId(GOLDEN) === TRX_ID, proven live (tools/refund-getblock-spike.cjs).
const TRX_ID = "779ffb0d9efc79e6d1a9bb21bf645534bb93d0f7";
const BLOCK_NUM = 81976371;
const GOLDEN = {
  ref_block_num: 56370,
  ref_block_prefix: 154474323,
  expiration: "2026-07-26T13:50:09",
  operations: [["transfer", { from: "kristi", to: "gram.gate", amount: "100.000 VIZ", memo: "UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv" }]] as Array<[string, Record<string, unknown>]>,
  extensions: [] as unknown[],
};

/** A block whose single tx is the golden transfer. */
const goldenBlock = () => ({ transactions: [structuredClone(GOLDEN)] });

interface Stubs {
  getTransaction?: (trxId: string, cb: (err: unknown, res: unknown) => void) => void;
  /** Keyed by the node URL currently set on viz.config (so rotation can be asserted). */
  getBlock?: (node: string, blockNum: number, cb: (err: unknown, res: unknown) => void) => void;
  lib?: number;
}

/** Install stubs on the viz singleton, tracking the node config.set selects, then restore. */
async function withViz<T>(stubs: Stubs, fn: (nodesSeen: string[]) => Promise<T>): Promise<T> {
  const orig = {
    getTransaction: viz.api.getTransaction,
    getBlock: viz.api.getBlock,
    gdgp: viz.api.getDynamicGlobalProperties,
    set: viz.config.set,
  };
  const nodesSeen: string[] = [];
  let current = "";
  viz.config.set = ((key: string, value: string) => {
    if (key === "websocket") { current = value; nodesSeen.push(value); }
    return orig.set.call(viz.config, key, value);
  }) as typeof viz.config.set;
  viz.api.getTransaction = ((trxId: string, cb: (e: unknown, r: unknown) => void) => {
    if (stubs.getTransaction) return stubs.getTransaction(trxId, cb);
    cb(new Error("Assert Exception (10) false: Unknown Transaction"), null); // pruned by default
  }) as typeof viz.api.getTransaction;
  viz.api.getBlock = ((blockNum: number, cb: (e: unknown, r: unknown) => void) => {
    if (stubs.getBlock) return stubs.getBlock(current, blockNum, cb);
    cb(null, null);
  }) as typeof viz.api.getBlock;
  viz.api.getDynamicGlobalProperties = ((cb: (e: unknown, r: unknown) => void) => {
    cb(null, { last_irreversible_block_num: stubs.lib ?? BLOCK_NUM, head_block_number: (stubs.lib ?? BLOCK_NUM) + 20, head_block_id: "00".repeat(20), time: "" });
  }) as typeof viz.api.getDynamicGlobalProperties;
  try {
    return await fn(nodesSeen);
  } finally {
    viz.api.getTransaction = orig.getTransaction;
    viz.api.getBlock = orig.getBlock;
    viz.api.getDynamicGlobalProperties = orig.gdgp;
    viz.config.set = orig.set;
  }
}

test("computeTrxId golden vector matches the incident trx id", () => {
  assert.equal(computeTrxId(structuredClone(GOLDEN)), TRX_ID);
});

test("pruned history + block hint -> reconstructs the deposit from the block log", async () => {
  const chain = new VizJsChain(["https://n1", "https://n2"], accounts);
  await withViz({ getBlock: (_node, _b, cb) => cb(null, goldenBlock()) }, async () => {
    const dep = await chain.getDeposit(TRX_ID, 0, BLOCK_NUM);
    assert.ok(dep, "expected a deposit from the block-log fallback");
    assert.equal(dep!.from, "kristi");
    assert.equal(dep!.to, "gram.gate");
    assert.equal(dep!.amountMilliViz, 100000n);
    assert.equal(dep!.blockNum, BLOCK_NUM);
    assert.equal(dep!.remoteChain, "GRAM");
    assert.equal(dep!.remoteDestination, "UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv");
    assert.equal(dep!.destinationValid, true);
  });
});

test("pruned history with NO hint -> null (fail-closed; today's behaviour, no fallback)", async () => {
  const chain = new VizJsChain(["https://n1"], accounts);
  let getBlockCalled = false;
  await withViz({ getBlock: (_n, _b, cb) => { getBlockCalled = true; cb(null, goldenBlock()); } }, async () => {
    assert.equal(await chain.getDeposit(TRX_ID, 0), null);
    assert.equal(getBlockCalled, false, "must not touch the block log without a hint");
  });
});

test("primary operation_history path still works and never hits the block log", async () => {
  const chain = new VizJsChain(["https://n1"], accounts);
  let getBlockCalled = false;
  await withViz(
    {
      getTransaction: (_id, cb) => cb(null, { operations: GOLDEN.operations, block_num: BLOCK_NUM, transaction_id: TRX_ID }),
      getBlock: (_n, _b, cb) => { getBlockCalled = true; cb(null, goldenBlock()); },
    },
    async () => {
      const dep = await chain.getDeposit(TRX_ID, 0, BLOCK_NUM);
      assert.equal(dep!.from, "kristi");
      assert.equal(getBlockCalled, false, "primary path must not fall back when it succeeds");
    },
  );
});

test("empty/pruned block on the first node ROTATES to the next node (empty read is not authoritative)", async () => {
  const chain = new VizJsChain(["https://n1", "https://n2"], accounts);
  await withViz(
    {
      getBlock: (node, _b, cb) => cb(null, node === "https://n2" ? goldenBlock() : { transactions: [] }),
    },
    async (nodesSeen) => {
      const dep = await chain.getDeposit(TRX_ID, 0, BLOCK_NUM);
      assert.ok(dep, "expected the second node's block log to confirm");
      assert.ok(nodesSeen.includes("https://n2"), "must have rotated to n2");
    },
  );
});

test("no configured node can confirm -> null (fail-closed), all nodes tried", async () => {
  const chain = new VizJsChain(["https://n1", "https://n2", "https://n3"], accounts);
  const blockNodes: string[] = [];
  await withViz({ getBlock: (node, _b, cb) => { blockNodes.push(node); cb(null, { transactions: [] }); } }, async () => {
    assert.equal(await chain.getDeposit(TRX_ID, 0, BLOCK_NUM), null);
    assert.equal(new Set(blockNodes).size, 3, "every node must be tried before failing closed");
  });
});

test("irreversibility gate: block > LIB is not yet final -> null", async () => {
  const chain = new VizJsChain(["https://n1"], accounts);
  await withViz({ getBlock: (_n, _b, cb) => cb(null, goldenBlock()), lib: BLOCK_NUM - 1 }, async () => {
    assert.equal(await chain.getDeposit(TRX_ID, 0, BLOCK_NUM), null);
  });
});

test("LYING hint: block whose txs don't recompute to trxId -> null (fail-closed, untrusted hint)", async () => {
  const chain = new VizJsChain(["https://n1"], accounts);
  // A different transfer at the hinted block: its recomputed id != TRX_ID, so it never matches.
  const other = { ...structuredClone(GOLDEN), operations: [["transfer", { from: "attacker", to: "gram.gate", amount: "100.000 VIZ", memo: "UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv" }]] };
  await withViz({ getBlock: (_n, _b, cb) => cb(null, { transactions: [other] }) }, async () => {
    assert.equal(await chain.getDeposit(TRX_ID, 0, 999999), null);
  });
});

test("structural violation in the matched block-log tx throws (normalized upstream to SourceMismatch)", async () => {
  const chain = new VizJsChain(["https://n1"], accounts);
  // opIndex 1 does not exist on the single-op golden tx.
  await withViz({ getBlock: (_n, _b, cb) => cb(null, goldenBlock()) }, async () => {
    await assert.rejects(() => chain.getDeposit(TRX_ID, 1, BLOCK_NUM), /no op at index 1/);
  });
});
