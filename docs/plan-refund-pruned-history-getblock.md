# Plan — Fix stuck peg-in re-read (F2) on pruned VIZ operation_history + semi-automatic resolution

Status: **IMPLEMENTED 2026-07-28** (all 9 steps below). Author session: 2026-07-28. Design refined
2026-07-28 (mint-redirect + operator resolution-directive file; live verification below).
Trigger incident: kristi's 100 VIZ peg-in `779FFB0D9EFC79E6D1A9BB21BF645534BB93D0F7:0` stuck.

## Implementation summary (2026-07-28)
- `computeTrxId` + `get_block` block-log fallback in `VizChain.getDeposit(trxId, opIndex, blockNumHint?)`
  (node-rotation on empty/pruned block; irreversibility gate; golden-vector proven). `viz-watcher`.
- `block_num` column persisted at PEG_IN enqueue (`store.ts` + migration + `viz-watcher`).
- UNTRUSTED `SourceHint` threaded coordinator→signer `/approve` (`sourceBlockNum`, out-of-band, NOT
  in the digest) → `validateAction`/`getDeposit`.
- `config/source-hints.json` loader + per-`/submit` hint resolver (DB block_num wins; file supplies
  when NULL) + run-once `resolution:"mint"` redirect (abandon refund child + re-drive parent),
  gated on the gateway being PAUSED (race-free). Kristi entry seeded.
- Tests: 21 new unit tests (computeTrxId golden vector, block-log fallback + rotation + irreversibility
  + lying-hint, hint threading, loader/precedence/redirect/double-pay guard) → 279 green; verify
  spikes green; `tools/refund-getblock-spike.cjs` (live). RUNBOOK §2a–§2c added.
- NOT YET DEPLOYED. Deploy = pause → push coordinator+signers → boot redirect fires once → unpause.

## Live verification (2026-07-28 implementation session) — all GREEN
Read-only, public-chain (no prod SSH):
1. **`get_block(81976371)` on api.viz.world returns the FULL block** — 1 tx / 1 op:
   `from=kristi → to=gram.gate, 100.000 VIZ, memo=UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv`.
   `transaction_ids: null` → **must recompute the graphene trxId** to bind the tx to `779FFB…`.
2. **No wVIZ ever delivered.** wVIZ jetton wallet for owner `UQCYd…` (raw `0:987532dd8d38…`) =
   `EQBfB_13LxiYrMaujcLt0N9wKzG7SCD50U6LfoesrIdJaTfB`, state **`uninitialized`**, balance 0.
   Parent is `REFUNDING` ⇒ mint definitively failed ⇒ **NO double-mint risk** from a delivered mint.
3. **Destination valid** — `UQCYd…` parses cleanly (non-bounceable user wallet, correct form).
Residual (designed around, not blocking): a pending-but-unexecuted multisig mint order — the
gateway's deterministic order (same action id → same order/seqno) collapses any re-drive + stale
order to a single execution, so re-minting stays idempotent.

## Decision (2026-07-28): REDIRECT kristi to MINT (not refund)
kristi's deposit is a valid peg-in (valid memo, delivery failed only during the outage window —
a plain REFUND child to the VIZ sender, NOT a `GRAM_RETURN`, so the destination was accepted as
valid). Completing the peg-in gives her the full 100 VIZ of wVIZ instead of 95 VIZ back (she'd
otherwise eat the 5 VIZ refund fee on an always-valid deposit). Minting re-reads the SAME pruned
source (`validatePegIn`), so the `getBlock` fallback is a prerequisite for the mint path too.
Still fully trustless: the destination is memo-derived and re-validated by each signer — operators
choose only "complete vs refund", never a recipient.

## Problem (verified 2026-07-28)

A REFUND child (`779ffb…:0:refund`, 95 VIZ → `kristi`) is in a hot retry loop (~954+
attempts). Both signers (op-2 `signer-op1:8101` [stale label], op-3 `175.110.112.214:8999`)
reject every attempt with:

```
SourceMismatchError: parent PEG_IN 779ffb…:0 for 779ffb…:0:refund
not found or not yet irreversible on VIZ
```

Root cause chain:
1. Deposit landed on-chain 2026-07-26 13:49Z (block 81976371) but was ingested ~29h late
   (2026-07-27 18:39Z) — it sat through the outage/pause window. Mint failed to deliver
   (16 attempts) → correctly spawned a `gross − refundFee` = 95 VIZ refund child.
2. Signer F2 (`packages/signer/src/sourceValidator.ts` `reReadParentPegIn` → `validateRefund`)
   re-reads the parent PEG_IN via `VizChain.getDeposit(trxId, opIndex)`
   (`packages/viz-watcher/src/vizChain.ts:295`), which calls `viz.api.getTransaction(trxId)`
   (the `operation_history` plugin) and checks irreversibility via
   `get_dynamic_global_properties.last_irreversible_block_num`.
3. By refund time the deposit's block is older than every reachable node's `operation_history`
   retention. VERIFIED via curl on ALL THREE configured nodes
   (`node.viz.cx,api.viz.world,mirror.viz.world`, set in `config/deploy.signer.yml:68` and
   `config/deploy.coordinator.yml:107`):
   - `operation_history.get_transaction(779ffb…)` → `Assert Exception … Unknown Transaction`
   - `operation_history.get_ops_in_block(81976371)` → `[]`
   So the by-txid lookup AND the block-scan the watcher uses both come back empty.
4. `getDeposit` catches the error and returns `null` (fail-closed). `VizChain.call()`
   (`vizChain.ts:202`) only rotates nodes on *transient* errors; "Unknown Transaction" is a
   non-transient app-level assert → NO failover. Even with failover it wouldn't help — no
   node's operation_history has it.

Funds are SAFE (100 VIZ sits in `gram.gate`; gateway over-backed). This stranded 100 VIZ is
the bulk of the site's `VIZ locked` > `wVIZ circulating` gap (~142.5). Resolving the refund
(95 VIZ → kristi) closes the gap to just real unswept fees.

## Key insight — the block log survives even though the history index is pruned

`database_api.get_block(blockNum)` reads the raw block log, a DIFFERENT store from the
`operation_history` index. VERIFIED 2026-07-28:
- `node.viz.cx` `get_block(81976371)` → 0 transactions (block log limited/pruned)
- **`api.viz.world` `get_block(81976371)` → the FULL block incl. kristi's exact transfer**
  (`from=kristi, to=gram.gate, amount=100.000 VIZ, memo=UQCYd…`). ✅
- `mirror.viz.world` → 0 transactions

So the F2 check CAN be satisfied trustlessly today — just not via the method the signer uses.

CAVEAT discovered: `get_block` returns each transaction's `operations`+`signatures` but NO
`transaction_id` (`transaction_ids` is `null`). To bind the block's transaction to the `trxId`
embedded in the action id, the signer MUST recompute the graphene transaction id
(sha256 of the serialized transaction → first 20 bytes, hex) and match it. Otherwise the
coordinator would control the trxId↔transaction mapping — a double-spend hole (a real transfer
could be re-pointed to a fabricated trxId/child id). viz-js-lib bundles the operation
serializer (`node_modules/viz-js-lib/lib/auth/serializer`) and `hash.sha256`
(`lib/auth/index.js`), so this is implementable in-repo.

## Design

Make `getDeposit` fall back to the block log when the history index can't serve the parent,
keeping F2 fully trustless. Keep the existing `getTransaction` path as PRIMARY (it works for
timely refunds — the common case); only stale/pruned lookups use the new path.

`getDeposit(trxId, opIndex, blockNumHint?)`:
1. Try `getTransaction(trxId)` as today. On success → unchanged behavior.
2. On unknown-tx / null AND a `blockNumHint` is present:
   a. Rotate across ALL configured nodes calling `get_block(blockNumHint)`. Treat an empty
      block / a block whose recomputed tx ids don't include `trxId` as "this node can't
      confirm" → try the NEXT node (empty read is NOT authoritative not-found — same lesson as
      the recon empty-backing false-pause, [[recon_empty_backing_read_false_pause_2026_07_28]]).
   b. For each candidate block, recompute each transaction's id and find the one == `trxId`.
   c. Verify `blockNumHint ≤ last_irreversible_block_num` (re-org safety).
   d. Take `operations[opIndex]`, assert transfer to a backing account, build `VizDeposit`
      exactly as the watcher does (same memo resolution / destinationValid logic).
   e. Only return `null` when EVERY node fails to confirm.
3. No hint and getTransaction failed → `null` (fail-closed, as today).

The `blockNumHint` is UNTRUSTED. Security rests on (b)+(d): the signer reads the block from its
OWN node and recomputes the tx id, so a lying hint just makes the lookup fail. F2 independence
preserved.

## Semi-automatic resolution — operator directive file (`config/source-hints.json`)

Goal (user, 2026-07-28): incidents of this class must resolve by **"edit a file, pull, restart"
— operators never hand-sign anything.** Future deposits self-heal automatically (the new
`block_num` column is populated at enqueue, so `getDeposit` always has a hint). This file is only
for deposits that predate the column, or edge cases where the hint is otherwise unavailable.

Shape — a per-incident directive keyed by the parent PEG_IN action id:
```json
{
  "779FFB0D9EFC79E6D1A9BB21BF645534BB93D0F7:0": {
    "sourceBlockNum": 81976371,
    "resolution": "mint"          // "mint" | "refund"  (omitted/refund = current default behavior)
  }
}
```

Consumption model = **coordinator relays** (chosen 2026-07-28). Only the coordinator reads the
file; ops edit it + pull/restart the coordinator ONLY. On boot / fan-out the coordinator:
- (a) supplies `sourceBlockNum` as the untrusted out-of-band hint to signers (same channel as the
  DB-relayed parent `block_num`; file overrides/supplies when the DB value is NULL).
- (b) if `resolution: "mint"`, performs the state redirect ONCE: atomically abandon the stuck
  REFUND child (so we can never both mint AND later broadcast the refund) and re-drive the parent
  PEG_IN mint. If `"refund"` / omitted → leave as-is (today's behavior).

Why this is safe (cannot become a manual-signing bypass):
- The block hint is UNTRUSTED — each signer reads the block from its OWN node and recomputes the
  trxId; a wrong number just fails closed. (Same lesson as
  [[recon_empty_backing_read_false_pause_2026_07_28]]: an empty read is never authoritative.)
- The destination is **memo-derived** and re-validated by `validatePegIn` on every signer — the
  directive selects mint-vs-refund, NEVER a recipient/amount. Ops cannot redirect funds.
- The hint is NOT in the CanonicalAction / digest — it cannot alter what gets signed.
- Re-driving the mint is idempotent (deterministic order per action id) — safe even against a
  stale pending multisig order.
- The redirect (abandon refund child + re-enqueue mint) is a coordinator STORE op guarded to run
  once per directive (idempotent on restart); it moves no funds itself — the signers' normal F2
  path does, after independent re-validation.

## Implementation steps

1. **Persist parent block number.** `action_outbox` has no `block_num` column
   (id, direction, remote_chain, recipient, sender, amount_milli_viz, fee_milli_viz, digest,
   status, attempts, last_error, txid, created_at, updated_at, next_attempt_at, parent_id).
   Add `block_num INTEGER` (nullable for back-compat). Populate at PEG_IN enqueue from
   `VizDeposit.blockNum` (already carried; see `vizChain.ts:271`). File:
   `packages/common/src/store.ts` (schema ~L191-208 + enqueue path) + the viz-watcher enqueue
   in `packages/viz-watcher/src/index.ts`.
2. **Thread the hint to signers.** Coordinator fan-out to `/approve` must include the parent's
   `block_num` as an out-of-band hint field (NOT part of CanonicalAction / digest). For a child
   (REFUND/FEE_SWEEP) the coordinator looks up the parent PEG_IN row's `block_num`; for a direct
   PEG_IN it's the row's own `block_num`. Inspect and wire: coordinator orchestrator fan-out +
   `packages/signer/src/index.ts` approve handler + `SourceValidatorDeps`/`getDeposit` signature.
   The hint flows into `reReadParentPegIn` and `validatePegIn`.
3. **`getDeposit` block-log fallback** in `packages/viz-watcher/src/vizChain.ts` per Design.
   Add a `getBlock(blockNum)` reader via `viz.api.getBlock`. Add node-rotation for the
   confirm-across-nodes loop (do NOT reuse the transient-only `call()` classifier for this —
   empty block must rotate).
4. **`computeTrxId(transaction)` helper** — ✅ PROVEN 2026-07-28 (recipe below matches live).
   ```js
   const operations = require("viz-js-lib/lib/auth/serializer/src/operations");
   const hash = require("viz-js-lib/lib/auth/ecc/src/hash");
   // trx = { ref_block_num, ref_block_prefix, expiration, operations, extensions } (NO signatures)
   const buf = operations.transaction.toBuffer(trx);      // the `transaction` serializer excludes sigs
   const trxId = hash.sha256(buf).slice(0, 20).toString("hex");
   ```
   NOTE: chain_id is prepended ONLY for signing (`Auth.signTransaction`), NOT for the id.
   GOLDEN-VECTOR unit-test fixture (captured from api.viz.world, block 81976371):
   ```js
   { ref_block_num: 56370, ref_block_prefix: 154474323, expiration: "2026-07-26T13:50:09",
     operations: [["transfer", { from:"kristi", to:"gram.gate", amount:"100.000 VIZ",
       memo:"UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv" }]], extensions: [] }
   // raw   = 32dc531735099110666a0102066b7269737469096772616d2e67617465a0860100000000000356495a00000000305551435964544c646a546a616f437578584f53675f7641725572477368514253697071483072437062795f637142457600
   // trxId = 779ffb0d9efc79e6d1a9bb21bf645534bb93d0f7   (== the incident's trxId) ✅ MATCH
   ```
5. **Failover classification**: `getDeposit`'s cross-node confirm loop treats empty/absent as
   rotate-and-retry; only `null` when all nodes exhausted. Keep the transient-retry `call()` for
   other reads.
6. **Infra / RUNBOOK**: document that at least one `VIZ_NODE_URL` entry MUST retain the full
   block log (api.viz.world qualifies today; node.viz.cx/mirror.viz.world do NOT). Consider an
   operator-run archive. Note the risk: if the block log is pruned on all nodes too, a true
   archive is required.
7. **Tests**: unit for getDeposit-via-block (mocked), computeTrxId golden vector, cross-node
   rotation on empty block, irreversibility gate; signer `validateRefund`/`validateFeeSweep`/
   `validatePegIn` with the hint path; a live spike `tools/refund-getblock-spike.cjs` hitting
   api.viz.world for block 81976371 proving end-to-end.
8. **Resolution-directive file** (`config/source-hints.json`) per the section above: loader +
   schema-validate on the coordinator, relay `sourceBlockNum` into the fan-out hint, and the
   run-once `resolution:"mint"` redirect (abandon REFUND child + re-drive parent mint). Seed the
   kristi entry (`779FFB…:0 → {sourceBlockNum:81976371, resolution:"mint"}`) so it self-heals on
   deploy. Tests: loader/validation, hint precedence (file over NULL DB), redirect idempotency
   (re-run on restart is a no-op), and that an omitted/`refund` directive is a no-op.
9. **Deploy**: coordinator + signers (op-2 co-located on axveer; op-3 operator-run box; op-1
   offline). After deploy the redirect fires once: the stuck `779ffb…:0:refund` child is
   abandoned and the parent PEG_IN re-drives → **100 wVIZ minted to `UQCYd…`** (F2 satisfied via
   the block-log path). Closes the site `locked > circulating` gap to just real unswept fees. No
   manual signing needed.

## Interim (NOT taken)
`tools/manual-refund.cjs` (2-of-3, bypasses F2 self-read) was available but user decided
2026-07-28: DO NOT touch prod manually — ship the fix and let the directive-file redirect complete
the peg-in (mint, not refund) via the trustless path. The hot retry loop is harmless (noisy) until
then. Deposit already verified real via explorer + api.viz.world get_block (see Live verification).

## Security review checklist (for implementation)
- blockNum hint untrusted → verified by own-node get_block + recomputed trx id match.
- computeTrxId golden-vector test MUST pass before trusting the path.
- empty read never authoritative: null only when ALL nodes exhausted (fail-closed preserved).
- hint is NOT in the canonical digest — it cannot alter what gets signed.
- F2 independence: signer reads ITS OWN node's block log, never coordinator-fed data.

## Open items to confirm at implementation time
- Exact `/approve` wire shape and where to attach the untrusted `sourceBlockNum` hint.
- viz-js-lib serializer API for a full transaction (vs single op) — confirm signed-tx digest.
- `op_in_trx` (opIndex) semantics: index within its transaction (matches watcher) → in
  get_block it's `transactions[k].operations[opIndex]` for the matched tx k. Confirm.
- Whether to eventually DROP the legacy getTransaction primary once the block-log path is proven.
```

Related memory: kristi_100viz_refund_stuck_f2_pruned_history_2026_07_28.
