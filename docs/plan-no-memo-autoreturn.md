# Plan — auto-return no-memo / invalid-destination peg-ins

**Status:** IMPLEMENTED 2026-07-16 (branch `feat/no-memo-refund-tooling`). All six design
sections landed + spikes green (`npm run verify` exit 0, unit 88/88). The two Out-of-scope items
below remain open (manual 2-of-3 refund of the already-stranded 2000 VIZ; unpausing).
**Problem owner:** federation operators
**Trigger:** live incident 2026-07-15 — `id → gram.gate` transfer of **2000 VIZ with an empty memo**
(tx `3FB76DC9A71731B98C408D934434A471298CAFD1`, block 81664757) was silently dropped by the
watcher and left stranded in `gram.gate`, producing ~2010 VIZ of over-backing.

## Current behaviour (the gap)

`packages/viz-watcher/src/vizChain.ts:202-212` — `irreversibleDepositsSince` calls
`validateRemoteAddress(chain, memo)`, which throws on an empty/malformed memo, and the handler
just `console.warn(... flag for manual refund); continue`. The deposit:

- is **never enqueued** (no outbox row, no durable record — only a log line), so
- is **never minted** (correct — a no-memo deposit has no mint destination), and
- is **never refunded** (the auto-refund path only fires for *tracked* peg-ins whose delivery
  window exhausts, via `dispatcher planChildren(REFUNDING)`).

The VIZ just sits in `gram.gate` → over-backing (safe direction, but funds stranded).

### Why the existing REFUND path can't be reused as-is

Even a *manual* refund through the gateway is blocked. Every operator's F2 re-validation
(`signer/src/sourceValidator.ts`) does:

```
validateRefund → reReadParentPegIn → vizChain.getDeposit(trxId, opIndex)
              → validateRemoteAddress(chain, "")   ← THROWS on empty memo (canonical.ts:40)
```

So all 3 signers reject → no 2-of-3 → no refund. `getDeposit` conflates two things:
"is this a real deposit event" and "does it have a valid *mint* destination." **Splitting
that conflation is the heart of this change.**

## The invariant that must NOT regress

> A no-memo / invalid-destination deposit must **never** be mintable.

The empty-memo rejection at the signer is a security control. This plan must keep the PEG_IN
(mint) path hard-rejecting invalid destinations; it only opens the REFUND path.

## Design

### 1. Reader: reconstruct destination-less deposits instead of throwing
`packages/viz-watcher/src/vizChain.ts`
- Add `destinationValid: boolean` (and keep `remoteDestination` as the raw memo, canonicalized
  to `""` when empty) to the `VizDeposit` type (`packages/common`).
- `irreversibleDepositsSince`: stop `continue`-ing on invalid memo. Instead compute
  `destinationValid` with a **non-throwing** variant of `validateRemoteAddress`, and return the
  deposit either way. Valid ones flow as today; invalid ones are returned flagged.
- `getDeposit`: same — return the reconstructed deposit with `destinationValid=false` rather
  than throwing. (Transport / not-yet-irreversible still returns `null`; only the *destination
  shape* stops being a throw.)

### 2. Keep mint strict
`packages/signer/src/sourceValidator.ts`
- `validatePegIn`: assert `deposit.destinationValid` and throw `SourceMismatchError` if false,
  **before** `assertSameAction`. This re-instates the never-mint guarantee at the trust layer
  (moved from the reader to the mint-validation layer — a deliberate relocation, not a removal).
- `validateRefund`: unchanged logic (recipient=`deposit.from`, amount=gross, digest bound to
  parent). It now succeeds for a destination-less parent because `getDeposit` no longer throws.

### 3. Canonical form is already destination-independent for the id
`packages/common/src/canonical.ts`
- `canonicalPegIn.id = ${trxId}:${opIndex}` — already destination-independent, so the refund
  child id (`…:refund`) and digest (`${parent.digest}:refund`) stay deterministically
  reconstructable by every signer from its own node read.
- The digest includes `recipient` (the memo). Canonicalize an invalid memo to a single sentinel
  (`""`) in the reader so all signers derive an identical digest. **Verify** `canonicalString`
  handles an empty recipient (it should — it's just a field value).

### 4. Watcher: enqueue invalid-destination deposits as HELD(needs-refund)
`packages/viz-watcher/src/index.ts`
- For `destinationValid === false`: enqueue the row (`direction: PEG_IN`, `sender: dep.from`,
  gross amount, digest from `canonicalPegIn`) with `status: "HELD"` and a distinct marker
  `lastError: "INVALID_DESTINATION"`. HELD already means "awaits refund or manual review"
  (`idempotency.ts:12`) and HELD rows never mark a chain mint-active (`store.ts:126-127`).
- Skip the caps check for these (a refund returns funds; caps guard minting).

### 5. Dispatcher: route HELD(INVALID_DESTINATION) straight to refund
`packages/dispatcher/src/index.ts` + `policy.ts`
- New branch (idempotent): pick up `HELD` PEG_IN rows with the `INVALID_DESTINATION` marker and
  a `sender`; call `planChildren(rec, "REFUNDING", …)` to build the `:refund` child, enqueue it,
  and set the parent → `REFUNDING`. From there the **existing** REFUND delivery + `REFUNDING →
  REFUNDED` close-out (`index.ts:151-153`) works unchanged.
- `store.enqueue` is idempotent on id, so re-running the branch cannot double-spawn.

### 6. Recon
No change needed — HELD/REFUNDING/REFUNDED never mark GRAM mint-active (`store.ts:126-127`), and
a refund lowers `locked` toward `circulating` (safe direction).

## Tests (the hard part — safety-critical)
- **Positive:** extend `tools/fee-sweep-refund-spike.cjs` (or a new `no-memo-refund-spike.cjs`):
  no-memo deposit → HELD(INVALID_DESTINATION) → REFUNDING → REFUND child → gross back to `from`
  → parent REFUNDED. Assert recipient=sender, amount=gross, digest=`${parent}:refund`.
- **Negative (critical):** extend `tools/signer-f2-spike.cjs`: a no-memo deposit is **NEVER
  mintable** — `validatePegIn` throws `SourceMismatchError` even though `getDeposit` now returns
  a deposit. Also assert a coordinator forging a PEG_IN with a fabricated memo is rejected
  (source-derived `destinationValid=false`).
- **Digest determinism:** two independent reads of the same no-memo deposit produce identical
  refund child id + digest.
- Add the new spike(s) to the `verify` script in `package.json`.

## Open decisions
- **Invalid-but-nonempty memos** (typo'd TON address): treat identically (refund to sender).
  Confirm no legitimate flow relies on a memo the regex rejects.
- **Refund recipient = `from`:** the VIZ sender is always a real account; returning to origin is
  the safe default even if `from` is an exchange/contract.

## Out of scope / separate
- **The already-stranded 2000 VIZ** is NOT fixed by this code (the scan cursor is long past
  block 81664757). It needs a one-off **out-of-band 2-of-3 multisig VIZ transfer**
  `gram.gate → id` for 2000 VIZ. See the manual-refund draft handed to operators.
- **Unpausing** the gateway is independent (the over-backing is the safe direction; recon only
  pauses on under-backing).

## Files touched
`packages/common` (VizDeposit type, non-throwing address check, canonical sentinel) ·
`packages/viz-watcher` (reader + enqueue) · `packages/signer` (validatePegIn strictness) ·
`packages/dispatcher` (HELD→REFUNDING branch) · `tools/*-spike.cjs` + `package.json verify`.
