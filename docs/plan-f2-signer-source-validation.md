# Plan — F2: signer independent source-event validation

**Status:** planned — implement in a dedicated session.  
**Severity:** 🔴 — direct theft vector; blocker before real funds.  
**Design:** `specs/2026-06-26-f2-signer-source-validation-design.md` (Obsidian vault)  
**Scope:** 7 tasks; implement TDD with a new offline spike (`signer-f2-spike.cjs`).

---

## Problem

The signer's security claim — "each operator independently validates the action before
signing" — is false. `actionFromWire(req.action)` in `signer/index.ts:54` takes the
`CanonicalAction` directly from the coordinator's HTTP request. `routeApproval` /
`keyedSigner` only verify **proposal-vs-action** consistency: a compromised coordinator
crafts a mutually consistent `(action, proposal)` pair for a non-existent or tampered
event, all honest operators sign identically → threshold met → funds stolen. The M-of-N
federation gives zero protection.

---

## Design (summary)

The signer independently fetches the **source event** from its own chain RPC using
`action.id` as the lookup key, re-runs `canonicalPegIn` / `canonicalPegOut`, and
asserts byte-identical `digest` before proceeding to proposal validation.

For **Solana peg-out**, the release target is not in a memo — it is implied by which
deposit ATA received the wVIZ. To verify this binding without spreading `MASTER_SEED`
across N operators, the derivation scheme changes to **additive Ed25519**:

```
childPub = masterPub + tweak(masterPub, vizAccount)·G   ← signer can compute (masterPub only)
childPriv = masterPriv + tweak(masterPub, vizAccount)   ← scanner only (masterPriv)
```

Every signer gets `DEPOSIT_MASTER_PUB` (safe public key); only the scanner holds
`DEPOSIT_MASTER_SEED`. The signer re-derives the expected deposit address from
`DEPOSIT_MASTER_PUB + vizAccount` and confirms it against the actual Solana burn source.

---

## Tasks

### Task 1 — Verify `viz.api.getTransaction` availability (spike prerequisite)

Before implementing, confirm that `viz.api.getTransaction(trxId, cb)` is accessible on
node.viz.cx and returns `{block_num, transaction: {operations: [[name, payload], ...]}}`.
This is the mechanism for point-lookup of a deposit without knowing the block in advance.

If unavailable: the fallback is a bounded `getAccountHistory` scan (the gateway account's
history) searching backward for the matching `trxId`. Document the decision in this file.

**RESULT (verified live 2026-06-28 against node.viz.cx):** `getTransaction(trxId, cb)` is
available (the lib maps it to the `operation_history` API, params `["trxId"]`). It returns
an annotated signed transaction with `operations: [[name, payload], ...]`, `block_num`, and
`transaction_id` at the **top level** — NOT nested under a `transaction` key as this plan
originally sketched. So `getDeposit` reads `tx.block_num` and `tx.operations[opIndex]`
directly. The fallback scan is not needed.

### Task 2 — `VizChain.getDeposit(trxId, opIndex)` interface + implementation

**Files:** `packages/common/src/adapters.ts`, `packages/viz-watcher/src/vizChain.ts`

Add to the `VizChain` interface:
```ts
/**
 * Fetch a single confirmed VIZ transfer op by transaction id + op index.
 * Returns null if the transaction does not exist or is not yet irreversible.
 * Throws if the op at opIndex is not a transfer to the gateway account.
 */
getDeposit(trxId: string, opIndex: number): Promise<VizDeposit | null>;
```

Implement `VizJsChain.getDeposit`:
- Call `viz.api.getTransaction(trxId)` → get block_num + operations
- Assert the block is irreversible: compare against `lastIrreversibleBlock()`
- Assert `ops[opIndex]` is a `transfer` to `this.gatewayAccount`
- Parse the memo with `parseRemoteTarget` and construct the full `VizDeposit`
- Return null (not throw) if trxId is not found; throw on structural violations

### Task 3 — Additive Ed25519 derivation (rewrite `depositAddress.ts`)

**Files:** `packages/solana-watcher/src/depositAddress.ts`

Replace the current HMAC-of-seed scheme with additive Ed25519 using `@noble/curves/ed25519`
(available as a transitive dep):

```
// tweak (deterministic scalar):
tweak(masterPub, vizAccount) = SHA-512(masterPub || DOMAIN || vizAccount)
                               reduced mod the Ed25519 group order l

// public derivation (signer-side, no secret needed):
childPub = ExtendedPoint.fromHex(masterPub)
           .add(ExtendedPoint.BASE.multiply(tweak))

// private derivation (scanner-side only):
childScalar = (masterScalar + tweak) mod l
childPub    = ExtendedPoint.BASE.multiply(childScalar)   // must match the above
```

New exports:
- `masterPubFromSeed(masterSeed: string): string` — derives base58 masterPub from the seed
  (SHA-512(seed-bytes)[:32] clamped → scalar → `·G` → base58 pubkey)
- `depositPubFromMasterPub(masterPub: string, vizAccount: string): PublicKey` — additive derivation
  from public key only (for signers)
- `depositAddressFromMasterPub(masterPub: string, vizAccount: string): string` — base58 wrapper
- Keep `deriveDepositKeypair` rewritten to use the scalar scheme (scanner/sweeper use)
- Keep `depositAddress`, `depositAta` wrappers updated to call the new scheme

**Breaking change:** existing registered deposit addresses will differ from new derivations.
Fine pre-launch. Clear `deposit_addresses` table on deploy of this change. Document in
RUNBOOK.

**Spike prerequisite (Task 7):** verify `childPub` derived from `masterPub` alone matches
`childPub` derived from `masterPriv` + `masterPub`.

### Task 4 — `RemoteChain.getBurn(sourceId)` + Solana implementation

**Files:** `packages/common/src/adapters.ts`, `packages/solana-watcher/src/solanaChain.ts`

Add to the `RemoteChain` interface:
```ts
/**
 * Fetch a single finalized burn/return by its source chain id.
 * Returns null if not found / not yet final.
 * For Solana: sourceId = transaction signature.
 * For TON: deferred (TON getBurn is complex; see note below).
 */
getBurn?(sourceId: string): Promise<RemoteBurn | null>;
```

Implement `SolanaChain.getBurn(sig)`:
- `conn.getParsedTransaction(sig, {commitment: 'finalized', maxSupportedTransactionVersion: 0})`
- Scan top-level + `meta.innerInstructions` for a `burn`/`burnChecked` on `this.mint`
- Extract: `{slot → height, burned_amount → amountMilliViz, source_ata_owner → from}`
  (source ATA owner = the deposit address, identifiable from parsed `accountKeys`)
- Extract `homeDestination` by querying the deposit registry — **caller's responsibility**:
  `RemoteBurn.homeDestination` is set in the signer's `validateSolanaPegOut`, not here
  (the chain adapter doesn't hold the store)
- Return null if tx not found; the full `RemoteBurn` from the parsed data (homeDestination
  left as empty string — the caller fills it in after the address-binding check)

**TON peg-out note:** TON's `sourceId` is a message hash; toncenter v2 has no clean
fetch-by-hash endpoint. TON peg-out is not yet active. For now, `TON RemoteChain` does
not implement `getBurn` and the signer logs a warning + proceeds without re-validation for
TON peg-out actions (explicitly accepted deferred risk). Revisit when TON peg-out is
activated.

### Task 5 — `sourceValidator.ts` in the signer package

**File:** `packages/signer/src/sourceValidator.ts` (new)

```ts
export interface SourceValidatorDeps {
  vizChain: VizChain;
  solanaChain: SolanaChain;   // needs getBurn()
  store: GatewayStore;        // needs depositAddressBy()
  depositMasterPub: string;   // base58 DEPOSIT_MASTER_PUB
}

export async function validateAction(
  action: CanonicalAction,
  deps: SourceValidatorDeps,
): Promise<void>;
```

Internally:
- **PEG_IN** (any remote chain, source = VIZ): `deps.vizChain.getDeposit(trxId, opIndex)` →
  build `VizDeposit` → `canonicalPegIn` → assert `derived.digest === action.digest &&
  derived.recipient === action.recipient && derived.amountMilliViz === action.amountMilliViz &&
  derived.remoteChain === action.remoteChain`. Throw `SourceMismatchError` on any deviation.

- **PEG_OUT from Solana** (identified by `action.id` being a base58 Solana signature):
  1. `deps.solanaChain.getBurn(action.id)` → partial `RemoteBurn` (no homeDestination yet)
  2. Look up deposit owner: `const rec = await deps.store.depositAddressBy(burn.from)` →
     `rec.vizAccount` = expected VIZ release target
  3. Verify address binding: `depositAddressFromMasterPub(deps.depositMasterPub, rec.vizAccount)`
     must equal `burn.from` (the deposit address that received the wVIZ)
  4. Set `burn.homeDestination = rec.vizAccount`; call `canonicalPegOut(burn)` → assert digest

- **PEG_OUT from TON** (deferred): log a warning, return without throwing (explicit accepted gap)

- **Action ID format detection for PEG_OUT**: a VIZ action ID is `<hex>:<int>`;
  a Solana signature is a 88-char base58 string. Use this to dispatch.

### Task 6 — Wire into `keyedSigner.ts` and `signer/index.ts`

**`packages/signer/src/keyedSigner.ts`:**
- Inject `SourceValidatorDeps` (or a `validateAction` function) into the constructor
- Call `await validateAction(action, deps)` at the top of `signVizRelease`,
  `approveTonMint`, and `approveSolanaMint` — before any proposal-vs-action checks
- The source validator throws on mismatch; the existing checks below it remain as defense-in-depth

**`packages/signer/src/index.ts`:**
- Instantiate `VizJsChain` (read-only, no gateway account write path needed) from
  `VIZ_NODE_URL` (existing config var)
- Instantiate `SolanaChain` (read-only, null writer) from `SOLANA_RPC_URL`
- Read `DEPOSIT_MASTER_PUB` from env (required for Solana peg-out validation)
- Pass the store (already instantiated) + chain readers + `DEPOSIT_MASTER_PUB` to
  `KeyedSigner`'s new `deps` argument

**Config (`packages/common/src/config.ts`):** add `depositMasterPub: string` to the
`solana` config section; load from `DEPOSIT_MASTER_PUB` env var (required when the signer
handles Solana peg-out).

### Task 7 — Offline spike + `npm run verify` integration

**File:** `tools/signer-f2-spike.cjs` (new)

Six test cases (all using mocked chain reads — no real RPC):

1. **Honest PEG_IN**: mock `getDeposit` returns the real deposit → validation passes → signing proceeds
2. **Tampered PEG_IN recipient**: coordinator changes `action.recipient` → digest mismatch → throws
3. **Tampered PEG_IN amount**: coordinator inflates `action.amountMilliViz` → throws
4. **Honest PEG_OUT Solana**: mock `getBurn` + store lookup + correct `masterPub` → passes
5. **Tampered PEG_OUT recipient**: coordinator changes `action.recipient` to another VIZ account →
   derived deposit address doesn't match → throws (address-binding check)
6. **Unknown deposit address**: `depositAddressBy` returns undefined → throws

**Additive key roundtrip** (standalone sub-test):
- Derive `childPub` from `masterPub` alone (verification path)
- Derive `childPub` from `masterPriv` (scanner path)
- Assert both produce the same base58 address

Print `[PASS]` / `[FAIL]` per case; exit non-zero on any failure.

Add to `npm run verify` in root `package.json` alongside existing spikes.

---

## Verification checklist (before merging)

- [x] Spike runs green: `npm run verify` (all F2 sub-cases pass; full suite exit 0)
- [x] Build green: `npm run build` + `npm run typecheck`
- [x] `DEPOSIT_MASTER_PUB` generation documented: `masterPubFromSeed(seed)` one-liner in
      RUNBOOK §5 + `.env.example`
- [x] RUNBOOK updated: deposit addresses change (clear `deposit_addresses` on deploy);
      `DEPOSIT_MASTER_PUB` + own-node independence required on the signer
- [x] `improvements.md` updated: F2 recorded as shipped; E1 annotated as superseded
- [x] `SUMMARY.md` updated (Obsidian vault)

**Implementation note (deviation from the original task sketch):** Task 3's "keep
`deriveDepositKeypair`" couldn't stand — a stock `Keypair` is seed-based and can't
represent an additively-derived scalar (seed→scalar via SHA-512+clamp isn't
homomorphic). So `deriveDepositKeypair` became `deriveDepositSigner` (returns the public
key + a scalar `signMessage`), and `SolanaChain.burnFromDeposit` now partial-signs the fee
payer and attaches the deposit's scalar signature via `addSignature`. `@noble/curves` was
promoted from transitive to an explicit `solana-watcher` dependency. Verified live: VIZ
`get_transaction` returns `operations`/`block_num` at the TOP level (not nested).

---

## Not in this PR

- TON peg-out source validation (deferred — TON peg-out not yet active)
- `#2` idempotent delivery: separate plan at `docs/plan-idempotent-delivery.md`
- Sweep-key decentralization (moving in-transit custody under the multisig)
