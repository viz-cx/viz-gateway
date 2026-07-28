#!/usr/bin/env node
// Live spike: prove the F2 block-log fallback end-to-end against a node that still
// retains the full block log (api.viz.world) for kristi's stranded 100 VIZ peg-in.
//
// Proves three claims the pruned-history fix rests on (docs/plan-refund-pruned-history-getblock.md):
//   1. database_api.get_block(81976371) returns the FULL block including kristi's transfer,
//      even though operation_history.get_transaction(779ffb…) is pruned/unknown.
//   2. The block's transaction_ids is null, so we MUST recompute the graphene trx id from the
//      serialized (UNSIGNED) transaction — sha256 -> first 20 bytes hex — to bind it to 779ffb….
//   3. The recomputed id for the matching tx == the incident's trxId.
//
// Run: node tools/refund-getblock-spike.cjs [nodeUrl] [blockNum] [expectedTrxId]
const viz = require("viz-js-lib");
const operations = require("viz-js-lib/lib/auth/serializer/src/operations");
const hash = require("viz-js-lib/lib/auth/ecc/src/hash");

const NODE = process.argv[2] || "https://api.viz.world";
const BLOCK_NUM = Number(process.argv[3] || 81976371);
const EXPECTED_TRX_ID = (process.argv[4] || "779ffb0d9efc79e6d1a9bb21bf645534bb93d0f7").toLowerCase();

viz.config.set("websocket", NODE);

/** Graphene trx id: sha256 of the serialized UNSIGNED transaction, first 20 bytes, hex. */
function computeTrxId(tx) {
  const buf = operations.transaction.toBuffer({
    ref_block_num: tx.ref_block_num,
    ref_block_prefix: tx.ref_block_prefix,
    expiration: tx.expiration,
    operations: tx.operations,
    extensions: tx.extensions || [],
  });
  return hash.sha256(buf).slice(0, 20).toString("hex");
}

function getBlock(blockNum) {
  return new Promise((resolve, reject) => {
    viz.api.getBlock(blockNum, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

function getTransaction(trxId) {
  return new Promise((resolve) => {
    viz.api.getTransaction(trxId, (err, res) => resolve(err ? { err: String(err) } : res));
  });
}

(async () => {
  console.log(`[spike] node=${NODE} block=${BLOCK_NUM} expect=${EXPECTED_TRX_ID}`);

  // Claim 1 (contrast): the operation_history index no longer serves it.
  const histResp = await getTransaction(EXPECTED_TRX_ID);
  console.log(`[spike] operation_history.get_transaction -> ${histResp && histResp.err ? histResp.err : "FOUND (index not pruned on this node)"}`);

  // Claim 1 + 2: the raw block log still has the full transaction.
  const block = await getBlock(BLOCK_NUM);
  if (!block) throw new Error(`get_block(${BLOCK_NUM}) returned empty on ${NODE} (block log pruned here?)`);
  const txs = block.transactions || [];
  console.log(`[spike] get_block returned ${txs.length} transaction(s); transaction_ids=${JSON.stringify(block.transaction_ids)}`);

  // Claim 3: recompute each tx id and find the match.
  let matched = null;
  txs.forEach((tx, k) => {
    const id = computeTrxId(tx);
    const op0 = tx.operations && tx.operations[0];
    console.log(`  tx[${k}] computed=${id} op0=${op0 ? op0[0] : "?"}`);
    if (id === EXPECTED_TRX_ID) matched = { tx, k };
  });

  if (!matched) throw new Error(`no transaction in block ${BLOCK_NUM} recomputed to ${EXPECTED_TRX_ID}`);
  const [name, payload] = matched.tx.operations[0];
  console.log(`\n[spike] MATCH tx[${matched.k}] id=${EXPECTED_TRX_ID}`);
  console.log(`[spike] op=${name} from=${payload.from} to=${payload.to} amount=${payload.amount} memo=${payload.memo}`);
  console.log(`[spike] OK — computeTrxId recipe + get_block fallback PROVEN live.`);
})().catch((e) => {
  console.error(`[spike] FAILED: ${e.message || e}`);
  process.exit(1);
});
