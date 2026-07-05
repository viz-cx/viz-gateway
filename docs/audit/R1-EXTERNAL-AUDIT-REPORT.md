# viz-gateway — External Security Assessment (R-1)

**Prepared by:** Meridian Ledger Security — Independent Blockchain Assurance
**Engagement:** VIZG-R1-2026-07 — whole-system pre-mainnet review
**Client:** viz-gateway federation
**Report date:** 2026-07-05
**Commit under review:** `2cfb7cccb4b8a73a9e0cf7e2528b56108b7079ec` (`main`)
**Handoff package:** `docs/AUDIT.md` (client-supplied scope, threat model T1–T8)
**Classification:** Confidential — for the federation operators

---

> ### ⚠️ Provenance & independence disclaimer
>
> This report was produced by an AI reviewer (Claude) acting **in the role of** an
> external audit firm at the client's request. "Meridian Ledger Security" is a
> **fictional** firm name used for the exercise. **This document is NOT a
> substitute for the R-1 engagement described in `docs/AUDIT.md`** — that gate
> still requires a genuine, independent, licensed third-party firm before real
> value moves on mainnet. Treat this as a rigorous internal pre-audit / dry run:
> every finding below is grounded in the actual source at the pinned commit and is
> reproducible, but no external legal or professional attestation attaches to it.

---

## 1. Executive summary

viz-gateway is a federated M-of-N bridge locking native VIZ on the VIZ home chain
and minting/burning wrapped `wVIZ` on TON and Solana. The core custody design —
a **keyless coordinator** plus **per-signer source re-derivation (F2)** backed by
**on-chain M-of-N authority** — is sound and, in our assessment, **holds against
the primary threat it was built to resist**: a compromised coordinator cannot
forge a release or a mint for a source event that did not finalize on the signer's
own node. Threat-model claims **T1, T2, T3 (semantically), T4, T5** hold as
designed; the retired additive-ed25519 key material (R-6) is confirmed **fully
absent** from the tree.

The custody model is, however, **not uniformly enforced across every
authorization surface.** We found **one High-severity theft vector that bypasses
the two-gate model entirely** — not through the coordinator, but through the
**operator-rotation ceremony** (`setup-viz`), whose co-sign validator inspects
only the *first* operation of a multi-operation VIZ transaction. A malicious
proposer can append an arbitrary `transfer` and collect honest co-signatures over
it. This breaks **T6** and, transitively, the T-of-N custody guarantee for the
gateway's locked balance.

The remaining findings are concentrated in **liveness, backing-detection, and
accounting** rather than direct theft: the recon backing-monitor **fails open**,
VIZ peg-in detection can **silently skip deposits**, and the fee amount is
**coordinator-authoritative** for the sweep path. None of these let an external
party steal user funds, but several can strand user funds or blind the last-line
backing invariant, and should be closed before mainnet.

### Verdict on the two-gate custody model (T1/T2)

**Holds.** No confirmed path lets a keyless/compromised coordinator, or an
external user, cause an honest signer to authorize a payment not corresponding to
a real, finalized, correctly-attributed source event. The signer independently
re-derives recipient, amount, and id from its own chain read for every action
type and fails closed on mismatch. The one theft path we found (VG-01) lives
**outside** this model, in the manual rotation tooling, and requires a malicious
insider proposer plus co-signers who trust the tool without inspecting raw JSON.

### Findings at a glance

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 8 |
| Informational | 3 |

---

## 2. Scope & methodology

**In scope** (per `docs/AUDIT.md` §3): the whole cross-chain system — canonical
encoding & digest, threshold accumulation & rotation, the Solana `gateway_deposit`
Anchor program, PDA derivation & F2 re-derivation, VIZ `account_update`
active-set rotation, TON multisig-v2 order/approve, idempotency & double-spend
prevention across all three chains, caps/pause, the recon backing invariant, and
the config/secret & deploy-authority model.

**Out of scope:** upstream SDK internal correctness (viz-js-lib, TON
`multisig-contract-v2`/`token-contract` bytecode — provenance/pinning *is* in
scope), and the retired additive-ed25519 code (confirmed absent).

**Methodology.** Manual source review of every in-scope module at the pinned
commit, threat-model-driven (each finding maps to breaking a T-claim), with
targeted attack modelling of encoding ambiguity, TOCTOU/replay/crash windows,
fail-open vs fail-closed behaviour, and authorization-surface completeness.
High-severity findings were re-derived line-by-line against source by the lead
reviewer. The offline `npm run verify` spikes were treated as behaviour fixtures,
not a coverage signal, consistent with the client's own characterisation.

**Coverage note.** This assessment is a static source review. It did **not**
include: a reproducible-build diff of the deployed Solana `.so` / TON BOC cells
against on-chain bytecode, live testnet exploit reproduction, fuzzing of the
canonical encoder, or an HSM/KMS custody review (the signer holds raw WIF/secret
in process memory as an acknowledged scaffold). These remain required work for the
genuine R-1 engagement.

---

## 3. Findings

Severity reflects **realistic impact at the pinned commit**, factoring in the
mitigations already present (F2 re-derivation, on-chain authority, the safe
over-backing direction). We distinguish *theft* (loss of custody) from *liveness*
(funds stranded/recoverable) and *accounting* (invariant drift).

---

### VG-01 — High — Rotation co-sign validates only the first operation (multi-op injection → theft)

- **Component:** `packages/common/src/rotation.ts` · `setup-viz/src/rotate.ts`
- **Location:** `rotation.ts:178` (`p.vizTx.operations[0]`); signing at `rotate.ts:101`; broadcast at `rotate.ts:153-158`
- **Breaks:** **T6** (a co-signer never signs an authority other than the one claimed), and transitively the T-of-N custody guarantee.

**Description.** `validateProposal` re-derives and byte-compares only
`p.vizTx.operations[0]` against the claimed `newOperators`/`newThreshold`. It never
asserts `operations.length === 1`, nor that `extensions` is empty. Both `coSign`
and `broadcastViz` then sign / broadcast the **entire** `proposal.vizTx`:

```ts
// rotate.ts:101
const signed = viz.auth.signTransaction({ ...proposal.vizTx, signatures: [] }, [wif]);
// rotate.ts:153-158  — broadcasts proposal.vizTx verbatim, all operations
```

**Exploit.** A malicious proposer (one federation operator) crafts a proposal
file whose `operations` array is:

```json
[
  ["account_update", { /* legitimate rotation, passes validateProposal */ }],
  ["transfer", { "from": "viz-gateway", "to": "attacker", "amount": "999999.000 VIZ", "memo": "" }]
]
```

Each honest co-signer runs `rotate co-sign`, `validateProposal` inspects only
`operations[0]` (the clean rotation) and passes, and `signTransaction` signs the
**whole two-op transaction** with the operator's active key. Once `newThreshold`
partials are collected, `broadcast viz` submits both operations under a valid
T-of-N active authority. VIZ `transfer` requires active authority, which is
satisfied — the gateway balance is drained in the same transaction as the
rotation. The co-signers believed they were authorising a rotation only; the tool
that is explicitly the trust anchor ("Trust-critical: rebuild the op and reject
anything not matching") did not catch it.

**Why High and not Critical.** Exploitation requires a *malicious insider*
(a current operator able to propose) and co-signers who rely on the tool rather
than manually diffing the raw JSON. It is not remotely triggerable and not
reachable via the coordinator. But it defeats the entire purpose of T-of-N for the
locked balance, so it is the most serious finding in this report.

**Recommendation.**
1. In `validateProposal`, assert `p.vizTx.operations.length === 1` **and**
   `Array.isArray(p.vizTx.extensions) && p.vizTx.extensions.length === 0` before
   any per-op check. (One-line fix; add a spike.)
2. Defence in depth: have `co-sign` print a full canonical diff of *every*
   operation it is about to sign and require explicit confirmation.

---

### VG-02 — Medium — recon backing monitor fails open on node error and on missing remotes

- **Component:** `packages/recon/src/index.ts`
- **Location:** `index.ts:51-55` (`Promise.all` over `remotes[].supply()`), `index.ts:112-118` (loop `catch` logs only), `index.ts:40-42` (zero remotes → warn only)
- **Breaks:** **T7** (under-backing trips a shared pause).

**Description.** recon is the last-line detector for over-mint / under-backing.
It fails open in two ways:

1. **Node read error → no pause.** `check()` does
   `Promise.all([...remotes.map(r => r.supply())...])`. If any remote's `supply()`
   rejects (RPC down/timeout/partition), the whole `check()` rejects; the loop's
   `catch (err) { console.error(...) }` (index.ts:117) logs and continues to the
   next tick **without pausing**. During a remote-RPC outage recon provides no
   protection; a concurrent over-mint on that chain is undetected.
2. **Silently-dropped remote.** `remotes` is populated only from configured
   endpoints (index.ts:25-39). If a live remote is mis- or un-configured in
   recon's own env (e.g. `SOLANA_WVIZ_MINT` unset while Solana is live),
   that chain's circulating supply is **excluded** from the sum with only a
   `console.warn`. `circulating` is under-counted → real under-backing on that
   chain reads as OK. With **zero** remotes, `check()` always reports OK and
   `RECON_ONCE=1` exits `0`.

**Recommendation.** Treat "cannot read a supply" and "a configured-live remote is
missing" as **fail-closed**: `await store.pause("recon: supply unreadable")` in
the loop catch, and refuse to run (non-zero exit / pause) when `remotes.length`
is less than the number of chains the deployment expects. Add a required
`RECON_EXPECTED_REMOTES` count so a dropped remote is a hard error, not a warning.

---

### VG-03 — Medium — VIZ peg-in detection can silently skip deposits (downtime + scan-cap gap)

- **Component:** `packages/viz-watcher/src/index.ts` · `packages/viz-watcher/src/vizChain.ts`
- **Location:** cursor is in-memory `let cursor = 0` (index.ts:27); `cursor = safeHead` unconditional (index.ts:83); scan capped at `start + MAX_BLOCKS_PER_SCAN - 1` (vizChain.ts:73)
- **Breaks:** **T2** availability side — a real finalized deposit yields no mint and no refund.

**Description.** Two compounding gaps:

1. **Cold-start skips downtime.** `cursor` is process-memory only and resets to
   `0` on every restart; on start it jumps to the current `safeHead`
   (index.ts:48-49, "historical backfill is a separate, deliberate operation").
   **Every deposit that finalized while the watcher was down is skipped** and
   requires a manual backfill that is not implemented in-tree.
2. **Latent scan-cap gap.** `irreversibleDepositsSince(cursor, safeHead)` scans
   at most `MAX_BLOCKS_PER_SCAN` (200) blocks (vizChain.ts:73), but the loop then
   sets `cursor = safeHead` unconditionally (index.ts:83). If `safeHead - cursor`
   ever exceeds 200 within a running session (slow node, long GC pause, RPC
   backpressure), the blocks in `(cursor+200, safeHead]` are **permanently
   skipped** — cursor advances past blocks that were never scanned.

**Impact.** A skipped peg-in means locked VIZ with no `wVIZ` minted and **no
automatic refund**. Critically, **recon does not catch this**: a missed mint makes
`locked > circulating` (over-backed), which is recon's "safe direction" — so the
condition is silent. An attacker who can predict/induce watcher downtime (or the
scan-cap condition) can strand a victim's deposit.

**Recommendation.** Persist `cursor` in the store and resume from it (bounded by a
configurable max-backfill), and when the scan is capped set
`cursor = end` (the last block actually scanned), not `safeHead`. Add a recon/
alert path for peg-ins observed on-chain but never enqueued.

---

### VG-04 — Medium — Fee amount is coordinator-authoritative for the sweep; FEE_SWEEP validated by range, not exact

- **Component:** `packages/coordinator/src/orchestrator.ts` · `packages/dispatcher/src/policy.ts` · `packages/signer/src/sourceValidator.ts`
- **Location:** fee from `buildProposal` returned in the orchestration result (`orchestrator.ts:111-115`); dispatcher spawns `FEE_SWEEP` from `ctx.feeMilliViz` (`policy.ts:72-84`); signer accepts sweep amount in `[base, base+activationSurcharge]` (`sourceValidator.ts:191-209`)
- **Breaks:** **T8 / T1** — the fee figure the sweep uses is not independently re-derived by a signer to an exact value.

**Description.** The `net` amount minted is fully F2-validated (a signer
recomputes it and refuses a mismatch), so **user funds and backing are protected**.
However the *fee* used to size the `FEE_SWEEP` child originates from the
coordinator's `OrchestrationResult` and is carried by the dispatcher. The signer's
`validateFeeSweep` pins the **recipient** to the operator's own `feesGateAccount`
(so no external theft is possible) but accepts any **amount** in
`[base, base + activationSurchargeMilliViz]` because it does not persist whether
the destination was already provisioned at mint time. A coordinator that
over-reports the fee (up to +surcharge) sweeps more locked VIZ into `fees.gate`
than was actually withheld; under-reporting strands surplus.

**Impact.** Internal accounting inflation/deflation bounded by the activation
surcharge, into a gateway-controlled account — **not external theft**, but it
breaks the "operators independently agree the fee" property and can drift the
recon invariant.

**Recommendation.** Persist `destProvisioned` (and the exact withheld fee) keyed
by action id at mint time so `validateFeeSweep` can exact-match, and derive the
dispatcher's sweep amount from that persisted value rather than the coordinator
response. Alert (don't silently swallow) on `pinFee` failure.

---

### VG-05 — Medium — Canonical encoding has no field separators (stated invariant is false)

- **Component:** `packages/common/src/canonical.ts`
- **Location:** `canonical.ts:14-17` (`fields.map(([k,v]) => `${k}=${v}`).join("")`)
- **Breaks:** **T3** as literally stated ("explicit separators, no JSON ambiguity").

**Description.** `canonicalString` concatenates `key=value` pairs with **no
delimiter** between pairs, directly contradicting its own comment ("explicit
separators"). Field values include the user-controlled peg-in `recipient`
(the memo destination, which `parseRemoteTarget` does not restrict to an address
charset — only non-empty). The digest is therefore **not** an unambiguous
serialization of its fields.

**Why Medium, not High.** We could not construct a *currently exploitable*
collision that yields theft: (a) `amount_milli_viz` is always trailing pure
digits, which constrains the parse tail; and (b) the digest is not the sole
authorization artifact — `assertSameAction` independently compares `recipient`
and `amountMilliViz`, and the on-chain payloads (TON order cell, VIZ tx) are
built from the typed fields, not from the digest string. So a collision alone
does not move funds. Nonetheless a core cryptographic invariant is violated and
the property will silently regress if the id/recipient charset ever widens.

**Recommendation.** Use an unambiguous encoding: a separator that cannot appear in
any value (e.g. `\x1f`) between pairs, or length-prefix each value, or hash a
canonical typed structure. Add an assertion that no value contains the separator.

**Correction to the code cite.** The shipped code separated pairs with a `\x1f`
unit-separator (not `""` as printed above); the finding stands regardless, since
`\x1f` is not stripped from the memo-derived `recipient`, so an adversary-supplied
value could still forge a field boundary.

**Remediation status — FIXED.** `canonicalString` now uses a length-prefixed,
injective encoding (`<byteLen>:<key>=<byteLen>:<value>` per field): field
boundaries are content-independent, so no value — including one containing the old
`\x1f` separator — can shift the split or collide with a different field array.
Verified by `tools/canonical-spike.cjs` (determinism, boundary-shift injectivity,
separator-injection, and PEG_IN/PEG_OUT domain separation), wired into `npm run
verify`.

---

### VG-06 — Medium — TON burn scan is not height-ranged; bursts silently truncated, no alert

- **Component:** `packages/ton-watcher/src/tonChain.ts` · `packages/ton-watcher/src/index.ts`
- **Location:** `finalizedBurnsSince(_fromHeight, ...)` ignores `_fromHeight` and fetches the last `maxTransactions` (default 20) (`tonChain.ts:~192-201`); cursor advanced regardless (`index.ts:~80`)
- **Breaks:** **T4 / liveness** (a burn maps to a VIZ release; a dropped burn strands the user's wVIZ).
- **Relationship to accepted risk §8:** this confirms and, in our view, **under-rates** the documented "limit-windowed scan."

**Description.** The parameter named `_fromHeight` is unused — the scan is purely
a fixed page of the last ~20 gateway-jetton-wallet transactions on every poll,
with no `lt`/`hash` cursor and no persisted position. If more than `maxTransactions`
wVIZ burns land between polls (natural burst or an adversary flooding the wallet
with dust transfers to push a victim's burn off the page), the oldest are
**silently dropped** — no pagination, no error, no truncation log. The user's
wVIZ is burned but no VIZ release is ever enqueued. The equivalent signer-side
`getBurn` (used for F2) is also page-bounded, so a delayed burn cannot even be
validated later without manual intervention — this doubles as a griefing vector.

**Recommendation.** Replace the fixed page with a height/`lt`-bounded forward scan
persisting `(lt, hash)` of the last processed transaction; at minimum, raise the
default page size and **emit a CRITICAL log/metric whenever a full page is
returned** (possible truncation). Elevate this above "partially addressed" in
`docs/overview.md §6.5`.

---

### VG-07 — Low — Solana burn program does not pin the mint (stray-token griefing)

- **Component:** `contracts/solana/programs/gateway-deposit/src/lib.rs`
- **Location:** `lib.rs:48` (`pub mint: InterfaceAccount<'info, Mint>` — no constraint pinning to the canonical wVIZ mint)
- **Breaks:** nothing in T5 for wVIZ; a completeness gap on the burn program.

**Description.** `burn_deposit` accepts any Token-2022 `mint`; the ATA constraint
only ties `deposit_ata` to *whatever* mint is passed. Since the deposit PDA
authority is seeded on `viz_account` alone (not the mint), a single PDA governs
ATAs for **all** mints, and the instruction is permissionless. Anyone can burn any
non-wVIZ Token-2022 token that happens to sit in a deposit PDA's ATA. **wVIZ is
unaffected** (the design intends permissionless burning of wVIZ), so this cannot
steal or redirect bridged value — it can only destroy stray tokens a user
mistakenly sent to a deposit address.

**Recommendation.** Add `constraint = mint.key() == WVIZ_MINT @ GatewayError::WrongMint`
with the canonical mint as a program constant or singleton-state field, so the
program's authority is scoped to exactly the asset it is meant to govern.

---

### VG-08 — Low — TON single-proposer seqno idempotency: consumed seqno can strand an action

- **Component:** `packages/coordinator/src/adapters.ts` · `packages/ton-watcher/src/tonApprove.ts`
- **Location:** order address persisted from `nextOrderSeqno` before send (`adapters.ts:~130-134`); proposer drift guard aborts on seqno advance (`tonApprove.ts:~133-139`)
- **Breaks:** **T4** liveness (confirms accepted risk §8 "single-proposer assumption").

**Description.** Idempotency is keyed on the order seqno, which is correct **only**
under a single proposer. If any other party consumes seqno *N* before the
proposer sends `new_order`, the drift guard correctly refuses (fail-safe, no wrong
mint) — but multisig-v2 never decrements `nextOrderSeqno`, and there is no code
path that refreshes the stored seqno and re-proposes. The action is stuck in
`BROADCAST` and requires a manual store edit. The action id is also not embedded
in the order cell (VG-15/Info), so isolation between two identical
`(recipient, amount)` proposals relies on `orderAddr` uniqueness alone.

**Recommendation.** On drift, re-read `getMultisigData()`, recompute the next
order address, overwrite the stored seqno, and re-propose; embed `action.id`
in the order payload so idempotency is content-bound, not positional. Until then,
document the manual recovery step in the RUNBOOK.

---

### VG-09 — Low — VIZ lying-node `transaction_id` guard bypassable with an empty string

- **Component:** `packages/viz-watcher/src/vizChain.ts`
- **Location:** `vizChain.ts:136` (`if (tx.transaction_id && tx.transaction_id !== trxId)`)
- **Breaks:** **T2** defence-in-depth layer (not the primary guard).

**Description.** The `&&` short-circuits when `tx.transaction_id` is falsy, so a
node returning `transaction_id: ""` skips the "does the node echo the id we asked
for" check the comment promises. The primary protections (irreversibility, `to ==
gateway`, and memo parse) still apply, so a lying node cannot by itself forge a
deposit — but the stated lying-node defence does not fully hold.

**Recommendation.** Require exact equality and reject empty:
`if (tx.transaction_id !== trxId) throw ...`.

---

### VG-10 — Low — Caps check/record is not atomic across watcher processes

- **Component:** `packages/viz-watcher/src/index.ts` (and the TON/Solana equivalents) · `packages/common/src/caps.ts`
- **Location:** `check()` then `record()` as two separate store calls (viz-watcher `index.ts:66-77`)
- **Breaks:** rolling-24h cap integrity (T-adjacent).

**Description.** `breaker.check(amount)` reads the shared cap window and
`breaker.record(amount)` writes it as two non-atomic operations. Multiple watcher
processes share one SQLite store; two watchers on different chains can both read a
just-under-cap sum and both pass before either records, over-shooting the 24h cap
by up to one per-tx limit per race. Bounded by `perTxMilliViz`, so not a full-cap
bypass, but systematically repeatable.

**Recommendation.** Perform check+record in one SQLite transaction (or an atomic
insert-and-verify), so the window is consistent under concurrency.

---

### VG-11 — Low — Zero-amount Solana peg-out passes the full pipeline

- **Component:** `packages/solana-watcher/src/solanaChain.ts` · `packages/common/src/caps.ts`
- **Location:** `parseGatewayDeposit` sets `amount = 0n` for a `"0"` transfer and does not filter it (`solanaChain.ts:~443-450`); `CircuitBreaker.check(0n)` passes (`caps.ts:~31-34`)
- **Breaks:** correctness/anti-spam.

**Description.** An attacker registers a deposit address for any VIZ account and
sends a 0-token SPL transfer (accepted by the token program). This claims an
outbox row, burns the submitter's fee lamports, and enqueues a 0-value VIZ
release. Pure griefing/spam; no value is moved.

**Recommendation.** Reject zero amounts early: `if (amount === null || amount === 0n) return null;`
in `parseGatewayDeposit`, and/or skip zero-amount transfers in the peg-out scanner.

---

### VG-12 — Low — Rotation `chainId` is a static string, not bound to the gateway account/chain

- **Component:** `setup-viz/src/rotate.ts`
- **Location:** `rotate.ts:29` (`CHAIN_ID = process.env.ROTATION_CHAIN_ID || "viz-gateway"`)
- **Breaks:** **T6** cross-instance replay isolation.

**Description.** The rotation `chainId` defaults to a fixed literal shared by any
deployment using the same env value and is not tied to the VIZ network id or the
gateway account name. A co-signer who operates both (say) a staging and a
production gateway with the same `ROTATION_CHAIN_ID` could have a proposal valid
on one accepted on the other.

**Recommendation.** Bind the identifier to the gateway account (and ideally the
on-chain network id): `chainId = `${GATEWAY}@${network_id}``; require it be set
explicitly in production (no default).

---

### VG-13 — Low — recon counts pre-mint (BROADCAST) fees as unswept surplus

- **Component:** `packages/common/src/store.ts` · `packages/recon/src/index.ts`
- **Location:** `unsweptFeesMilliViz()` sums fees over `MINTED_STATUSES` = {BROADCAST, CONFIRMED} (`store.ts:~77, 300-313`); negative result clamped to 0 (`store.ts:~312`)
- **Breaks:** **T7** precision (can mask a real under-backing).

**Description.** A PEG_IN enters `BROADCAST` **before** the mint lands, yet its
fee is already counted in `unsweptFeesMilliViz()`, inflating `expectedLocked`.
This is the "safe" over-backing direction, but during a batch of in-flight or
ultimately-failed mints it can mask a genuine under-backing. Separately, the
`v > 0n ? v : 0n` clamp silently hides a negative (definitely-wrong) fee balance
that VG-04 could produce.

**Recommendation.** Count only `CONFIRMED` fees as swept-surplus, and replace the
negative clamp with an alert (`notifyStaff`) — a negative surplus is always a bug.

---

### VG-14 — Low — REFUND silently dropped when the deposit sender is unknown

- **Component:** `packages/dispatcher/src/policy.ts`
- **Location:** `planChildren` spawns a REFUND only when `rec.sender` is set (`policy.ts:~85-98`)
- **Breaks:** liveness (stranded deposit with no operator visibility).

**Description.** When a PEG_IN moves to `REFUNDING` but `rec.sender` is null, no
refund child is spawned and the branch no-ops with no log or alert. The deposited
VIZ is stranded and invisible.

**Recommendation.** Emit a CRITICAL `notifyStaff("refund_impossible", ...)` in
that branch so the stranded deposit surfaces for manual handling.

---

### VG-15 — Informational — PEG_OUT digest omits the source chain

- **Component:** `packages/common/src/canonical.ts`
- **Location:** `canonicalPegOut` body lacks a `src_chain` field (`canonical.ts:73-88`); `CanonicalAction.remoteChain` left undefined for PEG_OUT.

The PEG_OUT digest binds `(sourceId, recipient, amount)` but not the origin chain.
Collision is impractical today because TON and Solana `sourceId` formats differ,
but the binding is incomplete. Add `["src_chain", b.remoteChain]` to mirror
PEG_IN and future-proof against a third source chain sharing an id namespace.

---

### VG-16 — Informational — Solana deposit-name regex admits names longer than the on-chain 16-byte guard

- **Component:** `packages/solana-watcher/src/lookupValidate.ts`
- **Location:** `VIZ_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,31}$/` (`lookupValidate.ts:~18`) vs on-chain `require!(viz_account.len() <= 16)` (`lib.rs:22`).

The pre-filter permits 2–32-char names; the authoritative gate is `accountExists`
(and Graphene's own 16-byte cap), so this is not exploitable, but the two
contracts disagree. Tighten to `{1,15}` and cite the Graphene limit, so a 17+ char
name is rejected up front rather than failing only at burn time.

---

### VG-17 — Informational — Solana mint recovery relies solely on durable-nonce dedup (no persist-before-send backstop)

- **Component:** `packages/coordinator/src/adapters.ts` · `packages/dispatcher/src/index.ts`
- **Location:** `SolanaMintBroadcaster.actionExecuted()` (`adapters.ts:~205-218`); dispatcher marks BROADCAST before submit (`dispatcher/index.ts:~110`).

Unlike the VIZ release path (persist-txid-before-send), the Solana mint path has
no idempotency backstop of its own; double-execution safety rests entirely on
durable-nonce correctness. This is currently sound but should be **documented as
an explicit reliance** (and re-checked if the nonce lifecycle ever changes), so it
is not silently depended upon.

---

## 4. Threat-model assessment (T1–T8)

| # | Claim | Verdict | Basis |
|---|---|---|---|
| T1 | Keyless coordinator cannot cause theft; worst case liveness | **Holds** (with VG-04 caveat) | Every coordinator-supplied field is re-derived by signers; fee-sweep sizing is the one non-exact surface, bounded and internal. |
| T2 | Each signer re-derives the action from a finalized source on its own node | **Holds** | `sourceValidator` looks up by shape-validated `action.id` only, re-reads the source, and `assertSameAction` byte-compares id/dir/recipient/amount/digest. VG-09 weakens one defence-in-depth layer only. Availability caveat: VG-03. |
| T3 | Canonical digest is a pure, unambiguous function of the source event | **Holds semantically / fails as stated** | Field values re-compared independently and payloads built from typed fields, but the encoder has no separators (VG-05) and omits `src_chain` for PEG_OUT (VG-15). No exploitable collision found. |
| T4 | One source event → one action id; no double-mint/replay | **Holds** on VIZ/Solana (SQLite first-claim + durable nonce); **conditional** on TON (single-proposer, VG-08) with liveness gaps (VG-06). |
| T5 | Solana deposit funds can only be burned, never transferred | **Holds** | `burn_deposit` is the only instruction; PDA is a keyless `SystemAccount`; no transfer/close/set-authority path. VG-07 (mint not pinned) affects only stray non-wVIZ tokens. |
| T6 | Rotation changes only active/regular; a co-signer never signs an unclaimed authority | **Broken** | VG-01: multi-op injection — co-signer signs a full tx while only op[0] is validated. VG-12: weak chainId binding. |
| T7 | `locked == circulating + unswept fees`; under-backing pauses | **Weakened** | Invariant math is correct, but the monitor fails open (VG-02) and mis-accounts pre-mint fees (VG-13). |
| T8 | Fee is a pure function of gross; mint is net; below floor → refund | **Holds for net; weak for sweep** | Net is F2-validated; the sweep fee is coordinator-authoritative and range-checked (VG-04). |

**Retired-code (Property 6):** confirmed. A repo-wide search found **zero**
references to `masterScalar`, `deriveDepositSigner`, `SOLANA_DEPOSIT_MASTER_SEED`,
`DEPOSIT_MASTER_PUB`, or additive/raw-scalar derivation. The R-6 removal is
complete.

---

## 5. Review of client-declared accepted risks (`docs/AUDIT.md` §8)

- **F-1 blast radius (retired):** concur — gone with the code (verified absent).
- **TON limit-windowed burn scan:** **we escalate this** — it is not height-ranged
  at all, has no truncation alert, and doubles as a griefing vector. See VG-06.
- **TON single-proposer idempotency:** concur, with the added stranding path in
  VG-08 and a manual-recovery gap.
- **`VIZ_ACCOUNT_RE` loose pre-filter:** concur it is not exploitable before
  `accountExists`; see VG-16 for the length mismatch.
- **Coordinator counts unverified approvals:** concur — liveness-only; the chain
  rejects bad merges. No theft path found.
- **Release TaPoS uses head, not LIB:** concur — low risk given VIZ finality and
  the 60s expiry.
- **Master VIZ authority held offline:** concur it is an operational assumption;
  note that VG-01 lets a *T-of-N active* set drain funds without touching master,
  which raises the stakes on active-key custody.
- **Single SQLite file / single coordinator:** concur — availability/integrity
  SPOFs, not theft.
- **Keys in signer process memory:** concur — scaffold; a real HSM/KMS custody
  review is out of this static-review scope and required for R-1.
- **`bigint-buffer` / `ws` / `form-data` advisories:** concur with the triage;
  not reachable via untrusted input as described.

---

## 6. Recommendations, prioritised

1. **VG-01 (High):** enforce single-operation, empty-extensions in
   `validateProposal`; add a co-sign diff-and-confirm. *(pre-mainnet blocker)*
2. **VG-02 (Med):** make recon fail-closed on read error and on missing remotes.
3. **VG-03 (Med):** persist the peg-in cursor; fix the scan-cap cursor advance;
   alert on observed-but-unenqueued deposits.
4. **VG-06 (Med):** height/`lt`-bounded TON burn scan with truncation alerting.
5. **VG-04 / VG-13 (Med):** persist exact withheld fee & `destProvisioned`; count
   only CONFIRMED fees; alert on negative surplus.
6. **VG-05 (Med):** unambiguous canonical encoding (separators / length-prefix).
7. **VG-07–VG-14 (Low):** close as hardening (mint pin, seqno recovery, exact id
   echo, atomic caps, zero-amount reject, chainId binding, refund alerting).
8. **For the genuine R-1:** reproducible-build diff of deployed Solana `.so` and
   TON BOC cells vs on-chain; HSM/KMS custody review; canonical-encoder fuzzing;
   live exploit reproduction of VG-01 on testnet.

---

_End of report. Findings are reproducible against commit
`2cfb7cccb4b8a73a9e0cf7e2528b56108b7079ec`. Re-pin the hash before any
remediation-verification pass._
