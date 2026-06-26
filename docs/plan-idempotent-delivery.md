# Plan — idempotent delivery (PR #2 review finding #2)

**Status:** not started. Architectural; do in a dedicated session.
**Severity:** 🔴 — double-mint / double-release of real funds.
**Blocks:** pointing real wVIZ at the gateway (alongside review #1, which is **done** —
see [`improvements.md`](./improvements.md) § "PR #2 review follow-ups").

## Problem

The dispatcher recovers orphaned `SIGNING` rows by requeueing them
([`dispatcher/src/index.ts`](../packages/dispatcher/src/index.ts), `tick`). This turns
delivery into **at-least-once with no idempotent sink**: if the process crashes *after*
the coordinator broadcast on-chain but *before* the row reached `CONFIRMED`, requeueing
re-submits → the coordinator re-orchestrates → a **second mint / second VIZ release**.

The per-direction `signingTimeoutMs` stopgap (landed with review #1) only widens the
margin so a slow-but-legit confirm isn't requeued; it does **not** close the crash
window. The real fix is to make delivery idempotent at the broadcast boundary.

## Design

Add an **on-chain idempotency check**: before broadcasting (and during SIGNING-orphan
recovery), ask the destination chain whether this `action.id` already executed. If it
did, adopt that txid and advance to `CONFIRMED` instead of re-broadcasting.

### 1. `Broadcaster.actionExecuted` (coordinator)
Extend the `Broadcaster` interface ([`coordinator/src/orchestrator.ts`](../packages/coordinator/src/orchestrator.ts)):

```ts
actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }>;
```

Call it in `Orchestrator.process` **before** `broadcast`; if executed, short-circuit to
a `CONFIRMED`-equivalent result carrying the existing txid (no new signatures collected).

Per-chain implementation (in [`coordinator/src/adapters.ts`](../packages/coordinator/src/adapters.ts)):
- **VIZ release** (`VizReleaseBroadcaster`) — scan the gateway account history for an
  outgoing `transfer` with `memo == action.id`. The memo already carries the id
  (`VizReleaseProposal.memo`), so this is clean. Add a `VizChain.releaseByMemo(memo)`
  read (reuse the `getOpsInBlock` / account-history path already in `vizChain.ts`).
- **TON mint** (`TonMintBroadcaster`) — query the multisig-v2 order by seqno / its
  executed flag. Ties into the unfinished real-order work (today `orderHashHex` is a
  digest stand-in, `adapters.ts`), so land it with the live multisig-v2 integration.
- **Solana mint** (`SolanaMintBroadcaster`) — **no memo today**. Add a memo instruction
  carrying `action.id` to the mint tx (`SolanaChain.buildMintProposal` / `submitMint`),
  then query by it (`getSignaturesForAddress` on the mint/recipient + parse memos, or an
  indexer). Durable-nonce gives partial protection (a re-signed *same* message fails once
  the nonce advances) but a fresh `buildProposal` reads the *current* nonce → new message
  → double mint, so the explicit marker is required.

### 2. `BROADCASTING` status (store + dispatcher)
The `BROADCAST` status already exists in the machine but is unused (a known dead branch,
PR #2 nit). Repurpose/clarify: the dispatcher sets a "may have hit chain" status **before**
the coordinator round-trip so recovery can distinguish "never left" from "possibly
broadcast". Recovery of such a row calls `actionExecuted` rather than blindly requeueing:
- executed ⇒ `CONFIRMED` (+ found txid)
- not executed ⇒ requeue `QUEUED`

(Decide during implementation whether the check lives in the dispatcher via a new
coordinator endpoint, or whether the dispatcher always routes recovery back through the
coordinator which checks internally. The latter keeps all chain reads in the coordinator.)

### 3. Cleanups bundled here
- Remove or properly set the dead `BROADCAST` branch in `MINTED_STATUSES`
  ([`store.ts`](../packages/common/src/store.ts)) — PR #2 nit.

## Test (offline spikes, `npm run verify`)
- `actionExecuted` true/false per chain (mock chain reads) drives short-circuit vs broadcast.
- Recovery of a `SIGNING`/`BROADCASTING` row that already executed → `CONFIRMED` (no
  re-broadcast), vs one that didn't → `QUEUED`.
- Extend `dispatcher-policy-spike` / `orchestration-spike`.

## Next-PR scope (this plan + the items below)

Bundle with this idempotent-delivery work, since they touch the same status machine /
broadcast path:
- **Nit — dead `BROADCAST` branch.** `MINTED_STATUSES` ([`store.ts`](../packages/common/src/store.ts))
  counts `BROADCAST` though nothing sets it today. This plan's `BROADCASTING` phase is
  what should set it; land them together.
- **Nit — `parentId` column.** The dispatcher closes a refund's parent via
  `rec.id.endsWith(":refund")` + `slice` ([`dispatcher/src/index.ts`](../packages/dispatcher/src/index.ts)).
  Works but is brittle; a `parentId` column survives an id-scheme change.

## Separate track (not this PR)
- **F2** (signer independent source-event re-derivation) — the theft vector; see
  PR #2 review #6. Includes the Solana peg-out address-binding check and the
  `MASTER_SEED` public/secret-derivation split. Its own design doc when picked up.

## Already done (PR #2 follow-ups, shipped this branch)
Review #1 (validate-before-burn), the per-direction `signingTimeoutMs` stopgap, #3
(burn-checkpoint recovery), #4 (SEEN-alert dedup), #5 (stale release/refund alert) —
see [`improvements.md`](./improvements.md) § "PR #2 review follow-ups".
