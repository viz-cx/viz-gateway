# Plan — TON peg-in on-chain idempotency (PR #11 review follow-up #1)

**Status:** ✅ DONE + MERGED — PR #12 merged to main on 2026-07-02 (main=`5980f08`). §§1–4 implemented, `npm run typecheck` + `npm run verify` (incl. the new TON spike cases 21–24) green; CI `build-and-verify` green. **Testnet re-proof (Verification §3) PASSED live on 2026-07-02** via `npm run e2e:ton:crash`: run `e2e-1782969608345-xq30y2`, predicted order seqno 5 (`EQA6KK2YLSuoFYYtq1NJ4YUxdJx6a7i6-LX8LROp5ShuhbGN`). The stack was SIGKILLed after `new_order` landed; the peg-in row already carried `txid == predicted order address` (persist-before-send held); exactly one order was created (seqno 5→6); orphan recovery short-circuited the row to `CONFIRMED` with `nextOrderSeqno` **stable at 6 — no second `new_order`** — and the recipient was credited `net=10343` mVIZ exactly once (not 2×).
**Severity:** 🔴 — double-mint of real wVIZ on TON.
**Blocks:** treating the TON peg-in path as production-safe. Solana and VIZ already close this window; TON is the last chain that does not.

## Problem

`GramMintBroadcaster.actionExecuted` ([`coordinator/src/adapters.ts:108`](../packages/coordinator/src/adapters.ts)) is a stub that unconditionally returns `{ executed: false }`. This disables the idempotency short-circuit in `Orchestrator.process` ([`coordinator/src/orchestrator.ts:63`](../packages/coordinator/src/orchestrator.ts)) for TON only.

The dispatcher deliberately creates an at-least-once delivery boundary: it marks a row `BROADCAST` *before* calling the coordinator, and its orphan-recovery requeues any stale `BROADCAST` row back to `QUEUED` ([`dispatcher/src/index.ts:83-96`, `104-114`](../packages/dispatcher/src/index.ts)). The comment there explicitly relies on `actionExecuted` to prevent a double-mint. For TON that backstop is absent.

**Double-mint sequence:**
1. Dispatcher: row → `BROADCAST`, POST `/submit` to coordinator.
2. Coordinator orchestrates → `submitMint()` sends a `new_order` to the TON multisig (returns the order address; on 1-of-1 with `approve_on_init=true` it self-approves and executes async).
3. **Crash** before the dispatcher records the coordinator's response (row stuck `BROADCAST`).
4. Orphan recovery requeues → re-POST `/submit`.
5. Coordinator calls `GramMintBroadcaster.actionExecuted` → **always `false`** → full re-orchestration → **second `new_order` → second mint** of wVIZ.

The `orderSeqno: "0"` stub in `buildProposal` ([`adapters.ts:95`](../packages/coordinator/src/adapters.ts)) was placed when the multisig-v2 contract was undeployed. It is now deployed on testnet (see memory `ton-testnet-deployed-2026-07-01`), so the real order-status query is now implementable.

## Design

Mirror the **persist-before-send + on-chain lookup** pattern that `VizReleaseBroadcaster` already uses (`adapters.ts:52-75`), adapted to TON's deterministic order addresses. TON order addresses are a pure function of `(multisig, orderSeqno)`, and `nextOrderSeqno` only advances when an order is actually created — so the order address is a durable idempotency key.

### 1. New TON chain read — order existence/execution

Add to `GramHttpChain` ([`gram-watcher/src/gramChain.ts`](../packages/gram-watcher/src/gramChain.ts)):

```ts
/** True if a multisig order at `orderAddr` is deployed on-chain (i.e. new_order landed). */
async orderExists(orderAddr: string): Promise<boolean>
```

Implementation: `this.client.getContractState(Address.parse(orderAddr))` and return `state.state === "active"` (or non-`uninit`). Existence of the order contract == the `new_order` was committed, which is the commitment we must not duplicate. (Do **not** gate on the `executed` flag from `Order.getOrderData()` — an order that exists but hasn't executed yet is still a commitment; re-broadcasting would create a *second* order. Existence is the correct, stronger predicate.)

### 2. Compute + expose the order address deterministically

Refactor `submitMint` (`tonChain.ts:188`) so the order address is derived from `nextOrderSeqno` and returned (already is), and split out a pure helper the broadcaster can call **before** sending:

```ts
/** Deterministic order address for the NEXT order this signer would create. */
async nextOrderAddress(): Promise<{ orderAddr: string; seqno: string }>
```

`submitMint` continues to send `sendNewOrder`; the broadcaster persists the address first.

### 3. `GramMintBroadcaster` — add store + persist-before-send

- Add `store: IdempotencyStore` to the constructor (mirror `SolanaMintBroadcaster`) and wire it in the coordinator entrypoint (`coordinator/src/index.ts` — find the `new GramMintBroadcaster(...)` site and pass the shared store).
- Replace the `orderSeqno: "0"` stub in `buildProposal` with the real seqno from `nextOrderAddress()` (or defer seqno resolution to `broadcast`).
- `broadcast`: call `nextOrderAddress()`, `store.setStatus(action.id, "BROADCAST", { txid: orderAddr })` **before** `submitMint`, then send. This makes recovery point at the intended order address even if the send crashes.
- `actionExecuted`:
  ```ts
  const rec = await this.store.get(action.id);
  if (!rec?.txid) return { executed: false };      // never reached send
  const exists = await this.chain.orderExists(rec.txid);
  return exists ? { executed: true, txid: rec.txid } : { executed: false };
  ```

**Residual window (document, do not silently accept):** a crash *between* `sendNewOrder` landing and the `setStatus(..., {txid})` commit would leave `rec.txid` unset. Because we persist *before* send, this window is inverted vs. the naive case — the txid is recorded first, so the only true gap is if `nextOrderAddress()` returns seqno N, we persist, but a *different* actor creates order N first. For the single-purpose gateway multisig (only this signer proposes) that cannot happen, so the window is closed in practice. Note this assumption explicitly in the code comment; if M-of-N / multi-proposer routing lands later, revisit with an action-id embedded in the order payload (see §5).

### 4. Regression test (offline)

Extend [`tools/idempotent-delivery-spike.cjs`](../tools/idempotent-delivery-spike.cjs) (or a new `ton-idempotency-spike.cjs`) with a TON-mocked case:
- `actionExecuted` returns `false` when no `rec.txid`;
- returns `{ executed: true }` when `rec.txid` set and mocked `orderExists → true`;
- returns `false` when `rec.txid` set but `orderExists → false` (order never landed → safe to resend).
Add to `npm run verify`.

### 5. Out of scope (note as future)

Embedding `action.id`/digest into the TON order payload (analog of the Solana memo) to enable a scan-by-action-id recovery would fully close the window even under multi-proposer M-of-N. It requires an on-chain message-format change and a fresh testnet proof — defer until M-of-N on-chain approval routing is designed.

## Verification

1. `npm run typecheck` — green.
2. `npm run verify` — offline spike incl. the new TON case green.
3. **Testnet re-proof (required before merge):** re-run the TON peg-in e2e proof (see `RUNBOOK.md` and the driver used for `ton-testnet-deployed-2026-07-01`), then simulate the crash window: kill the process after `new_order` lands but before `CONFIRMED`, confirm orphan recovery + `actionExecuted` short-circuits to `CONFIRMED` with **no second order** on-chain.

   **Harness ready (built 2026-07-02, not yet run live):** `npm run e2e:ton:crash` drives this automatically against the testnet stack in `.env.e2e`:
   - reads the multisig `nextOrderSeqno` up front and derives the deterministic order address it will consume;
   - locks VIZ, waits until the `new_order` contract is `active` on-chain, then **SIGKILLs the whole stack** (crash before `CONFIRMED`);
   - asserts the persist-before-send invariant (the peg-in row already carries `txid = predicted order address`), then forces the row back to `BROADCAST` to reproduce the stranded state, and confirms exactly one order exists (`seqno → seqno+1`);
   - relaunches the stack with a shortened `DISPATCHER_SIGNING_TIMEOUT_PEG_IN_MS` so orphan recovery fires in seconds; waits for the row to reach `CONFIRMED`;
   - **primary oracle:** `nextOrderSeqno` is unchanged across recovery → no second `new_order` (a double-mint would advance it). **Confirmation:** recipient wVIZ delta `== net` exactly once, not `2×net`.

   Driver: [`tools/e2e/crash-recovery.ts`](../tools/e2e/crash-recovery.ts); on-chain reads reuse the production `Multisig` wrapper + the same `state === "active"` predicate as `GramHttpChain.orderExists`. It does not burn the minted wVIZ back — a normal `npm run e2e:ton` round trip can sweep it afterwards.

## Files

- `packages/coordinator/src/adapters.ts` — `GramMintBroadcaster` (store, `buildProposal`, `broadcast`, `actionExecuted`)
- `packages/coordinator/src/index.ts` — wire the store into `new GramMintBroadcaster(...)`
- `packages/gram-watcher/src/gramChain.ts` — `orderExists`, `nextOrderAddress`
- `tools/idempotent-delivery-spike.cjs` (or new spike) — regression case; register in `npm run verify`
- `tools/e2e/crash-recovery.ts` — live crash-window proof driver; `tools/e2e/ton.ts` — `nextOrderInfo`/`nextOrderSeqno`/`orderExists` helpers; `package.json` — `e2e:ton:crash` script; `tools/e2e/tsconfig.json` — `contracts/ton` reference
- `docs/improvements.md` — mark this follow-up as done once merged
