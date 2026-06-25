# viz-gateway — Architecture Overview & Code Review

_Originally a reviewer's pass at commit `835c7e0`; **updated** after the phase A–E
improvements landed. Pairs the research/threat doc
([`VIZ-Gateway-Research-and-Plan.md`](../VIZ-Gateway-Research-and-Plan.md)) with a
ground-truth read of the TypeScript. The implementation record for the changes is in
[`docs/improvements.md`](./improvements.md); §6 below marks each original finding's
status. Several services can't be `tsc`-built locally on Windows (the `viz-js-lib`
git dep's build script is Unix-only) — they compile on Linux CI._

## 1. What it is

A federated **M-of-N multisig bridge** between the **VIZ** blockchain (the "home"
chain, where the native asset is locked/released) and one or more **remote** chains
(TON live, Solana read-path prepped) where **wrapped VIZ (`wVIZ`)** is minted/burned.

- **Peg-in**: lock VIZ on VIZ → mint `wVIZ` (net of fee) on the remote chain.
- **Peg-out**: send `wVIZ` back on the remote chain → release VIZ on VIZ. On Solana
  there is no usable memo, so routing is by a deterministic per-VIZ-account **deposit
  address** (Variant A): the address received-on is the routing identity.

The peg-in fee is taken **on the VIZ side** (held in VIZ, swept to a `fees.gate`
account); we mint net. Peg-out and refunds are free.

The defining design choice is that the **trust-critical core is chain-agnostic**.
Every operator independently re-derives a deterministic *canonical action* from a
finalized source event and signs only that. The component that orchestrates and
broadcasts (`coordinator`) **holds no keys**, so compromising it can stall the
bridge but cannot steal funds.

Default/target federation: **5-of-7** (BFT-clean for `f=2`); bootstraps at **1-of-1**
so one operator can run a working bridge solo and grow with no redeploy.

## 2. Component map

| Package | Trust | Role |
|---------|-------|------|
| [`packages/common`](../packages/common/src) | **critical** | Chain-agnostic core: canonical encoding/digest, types, config, caps, fees, **durable outbox + shared cap window + deposit-address registry** (`store.ts`), threshold accumulation, operator rotation. Dependency-light by rule. |
| [`packages/viz-watcher`](../packages/viz-watcher/src) | read+sign | Follows VIZ irreversible head, detects deposits (peg-in source) → enqueues; VIZ release signing/broadcast. |
| [`packages/ton-watcher`](../packages/ton-watcher/src) | read+sign | TON finality + `transfer_notification` burn detection (peg-out source), TON mint-order approval. |
| [`packages/solana-watcher`](../packages/solana-watcher/src) | read+sign | Solana `RemoteChain` adapter (finalized slot, supply, burn parse, provisioning check) + SPL/Token-2022 mint signing + **deposit-address derivation, lookup service, peg-out scanner, burn**. |
| [`packages/signer`](../packages/signer/src) | **holds keys** | The only key-holding service. Re-validates each proposal against the independently-derived action (incl. re-deriving the fee), then signs. One per operator. |
| [`packages/coordinator`](../packages/coordinator/src) | **untrusted** | Keyless orchestration: builds one shared proposal (computes net + pins provisioning), collects partials to threshold, broadcasts. |
| [`packages/dispatcher`](../packages/dispatcher/src) | keyless | Drains `QUEUED` outbox rows to the coordinator with retry/backoff; spawns `FEE_SWEEP` / `REFUND` children. |
| [`packages/recon`](../packages/recon/src) | watchdog | Reconciliation/circuit-breaker: `locked == circulating + unswept fees` across all remotes; submitter SOL reserve monitor; trips shared pause on under-backing. |
| [`packages/log`](../packages/log/src) | — | winston structured logging + `notifyStaff` operator alerts (kept out of `common`). |
| [`contracts/ton`](../contracts/ton), [`contracts/solana`](../contracts/solana) | — | Remote-chain contracts + deploy scripts (dry-run by default) + TON rotation. |
| [`setup-viz`](../setup-viz/src) | — | One-time VIZ account setup + operator-rotation CLI. |
| [`tools/*.cjs/.mjs`](../tools) | — | Offline `node:assert` spikes — **this is the test suite** (`npm run verify`). |

## 3. The trust model in one read

```
 source event (finalized)         each operator, independently
        │                                   │
        ▼                                   ▼
 watcher detects ──► enqueue (outbox) ──► dispatcher ──► coordinator builds ONE proposal
 (idempotency claim,    (action = GROSS,                  (computes net, pins
  caps → HELD or QUEUED) deterministic digest)             provisioning) │
        │                                                                ├─► signer #1: re-derive action,
        │                                       │            validate proposal == action,
        ▼                                       │            sign  ──► partial
   POST /submit ───────────────────────────────┤
                                                ├─► signer #2 … (until T partials)
                                                ▼
                                  broadcast merged signatures to the chain
                                  (chain enforces the real M-of-N authority)
```

Two independent gates protect custody:

1. **Per-signer validation** ([`keyedSigner.ts`](../packages/signer/src/keyedSigner.ts)):
   each signer checks `proposal.to/recipient`, `amount`, and `memo/id` against the
   action *it* derived from the source event before signing. A malicious coordinator
   cannot get an honest signer to sign the wrong recipient/amount.
2. **On-chain authority**: the merged signatures must satisfy the real M-of-N
   authority on VIZ/TON/Solana. Forged or under-threshold approvals simply fail at
   broadcast — a liveness event, never a theft.

The canonical digest ([`canonical.ts`](../packages/common/src/canonical.ts)) is a
pure function of the source event with fixed field order and explicit separators
(no JSON ambiguity), so honest operators produce byte-identical bytes and their
signatures aggregate. `remoteChain` is committed *into* the peg-in digest, so the
target network can't be swapped after the fact.

## 4. State & safety primitives

- **Durable outbox + pause** ([`store.ts`](../packages/common/src/store.ts)):
  one shared SQLite file (`node:sqlite`, WAL) holds the `action_outbox` (every source
  event = one row with a delivery state machine), the shared `cap_window`, the
  `deposit_addresses` registry, and a global `paused` flag. `enqueue()` is an atomic
  `INSERT OR IGNORE` first-claim. State machine:
  `SEEN → QUEUED → SIGNING → BROADCAST → CONFIRMED`, with `HELD`, `REFUNDING →
  REFUNDED`, terminal `FAILED`. Pause is **1-of-N to trip, deliberate to clear** —
  watchers stop scanning, the signer returns HTTP 423.
- **Caps / circuit breaker** ([`caps.ts`](../packages/common/src/caps.ts)):
  per-tx, rolling-24h (now backed by the shared `cap_window`, so it's cross-process
  and survives restart), and manual-review thresholds; 24h breach trips the pause.
- **Fees** ([`fees.ts`](../packages/common/src/fees.ts)): held in VIZ.
  `base = max(10 VIZ, 0.20%)` (a pure function of gross → operators agree) + a
  per-chain **activation surcharge** when the destination isn't provisioned; mint
  `net = gross − fee`; reject (→ refund) below the mint-gas floor. Integer milli-VIZ.
- **Rotation** ([`rotation.ts`](../packages/common/src/rotation.ts)): T-of-N
  self-governing operator-set change via a single VIZ `account_update` (master
  omitted), with a re-derive-and-compare validator so a co-signer never signs an
  authority other than the one claimed.

## 5. What's actually wired vs. pending

**Live/verified (per README + spikes):** VIZ & TON read paths against real nodes;
reconciliation tripping the shared pause; cross-process idempotency + pause;
write-path signing (VIZ partials merge; TON ed25519 order approval; Solana durable-nonce
SPL mint); orchestration at 1-of-1 and 2-of-3.

**Added since (phases A–E, see [`improvements.md`](./improvements.md)):** the durable
outbox + dispatcher; VIZ-side fee with mint-net and the pinned activation surcharge;
per-peg-in `FEE_SWEEP` to `fees.gate` and `REFUND` on delivery-window exhaustion;
multi-remote recon with unswept-fee accounting; the Solana peg-out deposit-address
model (derivation + registry spike-verified; lookup/scanner/burn built). Solana
innerInstructions parsing, RPC throttling, and confirm-after-broadcast.

**Pending live on-chain targets (logic present, targets missing):**
`VizJsChain.broadcastRelease` needs a funded gateway account; TON `submitMint` is a
deliberate `throw` (multisig-v2 mint is an on-chain `new_order`+`approve` flow, not
off-chain sigs); the Solana mint + peg-out burn need devnet validation. The lookup
service still needs a real VIZ-account existence check. **Nothing here moves real
funds yet.**

## 6. Review findings

Severity is relative to the project's own "early but partly live" status. None of
these were theft vectors (the two-gate model holds); they were correctness,
backing-invariant, and liveness gaps. **Status added per finding** after phases A–E.

### 6.1 Peg-in fee is computed but never applied — `High` → ✅ RESOLVED (Phase C)

The fee model is now implemented: the action carries gross, the coordinator mints
`net = gross − fee`, and the fee is swept to `fees.gate` per peg-in. Recon accounts
for unswept fees so the invariant holds exactly. (Original analysis below.)

[`viz-watcher/src/index.ts:64`](../packages/viz-watcher/src/index.ts#L64) calls
`quotePegIn(...)` and **logs** `quote.net`/`quote.fee`, but the action forwarded to
the coordinator is `canonicalPegIn(dep)`, whose `amountMilliViz` is the **gross**
deposit ([`canonical.ts:52`](../packages/common/src/canonical.ts#L52)). The TON/Solana
mint proposals therefore mint the **gross** amount. Net effects:

- The fee model the README describes ("net to user, fee to treasury, 1:1 backing
  preserved") is **not implemented** — there is no treasury split anywhere in the code.
- The peg invariant `locked == circulating` still holds (both gross), so recon won't
  flag it; the gap is silent. Fee revenue is effectively zero.

Closing it means deriving the canonical action from `quote.net` and routing
`quote.fee` to a treasury mint/account.

### 6.2 Reconciliation ignores Solana — `High` → ✅ RESOLVED (Phase C4)

Recon now sums circulating wVIZ across **every** configured remote (TON + Solana) and
checks `locked == circulating + unswept fees`, alarming only on under-backing.
(Original analysis below.)

[`recon/src/index.ts`](../packages/recon/src/index.ts) compares VIZ locked balance
against **TON jetton supply only**. The README claims recon "computes locked-VIZ vs
circulating-wVIZ from **both** live adapters," but `SolanaChain` is never instantiated
here. The moment wVIZ is minted on Solana, true circulating = TON supply + Solana
supply, so:

- recon under-counts circulating → on a legitimate Solana mint it would report
  `locked > circulating` and could mask an over-mint on TON, **or**
- if Solana is the only active remote, recon compares against a chain that has no supply.

The multi-chain reconciliation must sum supply across **every** configured remote
adapter. (Today it's structurally single-remote.)

### 6.3 24h caps are per-process and reset on restart — `Medium` → ✅ RESOLVED (Phase B4)

The rolling window now lives in the shared `cap_window` table, so the cap is
cross-process and survives restart. (Original analysis below.)

Each watcher owns a private in-memory `CircuitBreaker`
([`caps.ts:18`](../packages/common/src/caps.ts#L18)); the rolling window lives in
process memory. The README acknowledges "the 24h cap counters are still per-process."
Two consequences worth making explicit:

- The cap is **bypassable by restarting** the watcher (window resets to empty).
- VIZ peg-in and remote peg-out keep **separate** windows, so the aggregate daily
  flow can exceed either single cap.

The *pause* they trigger is shared (good); the *accounting* is not. Persisting the
window (or moving it into the shared store) closes this.

### 6.4 Held/dropped deposits are claimed then silently stranded — `Medium` → ✅ RESOLVED (Phase B)

The watchers now `enqueue` into the durable outbox and set `HELD` (not `continue`) on
caps/min failure; the dispatcher retries `QUEUED` and refunds on window exhaustion.
Nothing is dropped. (Original analysis below.)

In all three watchers, `store.claim(action.id)` (persistent) runs **before** the
fee/cap checks. When a deposit is then held (`BELOW_MIN`, `OVER_PER_TX`,
`NEEDS_MANUAL_REVIEW`) or the coordinator `submit` throws, the code `continue`s —
but the id is already claimed, so it is **never retried**. The action sits at `SEEN`
with only a log line. The viz-watcher comment flags this for the submit path
("persist to an outbox and retry … needs operator follow-up until the outbox exists"),
but the cap/min-held paths strand just as quietly. An outbox or a `HELD`/`REFUND`
state with an operator queue would make these recoverable rather than log-only.

### 6.5 Burn scans are limit-/time-windowed, not height-ranged — `Medium` → ◑ PARTIAL (Phase A)

The bigger bug — missing CPI/inner-instruction transfers — is fixed (A1), and the scan
limit is now configurable with RPC throttling (A2). The underlying completeness gap
(limit-windowed rather than `fromHeight`-ranged, so a burst beyond the page is still
missed) remains. (Original analysis below.)

[`tonChain.finalizedBurnsSince`](../packages/ton-watcher/src/tonChain.ts#L75) ignores
`fromHeight` and reads the **last 20** txs; [`solanaChain.finalizedBurnsSince`](../packages/solana-watcher/src/solanaChain.ts#L56)
reads the **last 25** signatures. Under burst load (> limit relevant txs inside one
finality window) older burns fall off the page and are **missed**. Idempotency prevents
double-processing but not missed-processing, and the watcher cursor advances past them
regardless. A paginated scan bounded by the persisted height range would be safe;
the VIZ side already block-ranges (capped at `MAX_BLOCKS_PER_SCAN`) and is the model
to follow.

### 6.6 Smaller notes

- ✅ **Stale comment in recon** — fixed; recon was rewritten (multi-remote + reserve
  monitor) and the TODO removed.
- ⏳ **Release proposal expiration is 60s** ([`vizChain.ts`](../packages/viz-watcher/src/vizChain.ts)).
  Still as-is; fine because the orchestrator collects partials synchronously, but worth
  revisiting if signing goes async.
- ⏳ **No VIZ-account existence check** before a peg-out release (and now before issuing
  a deposit address in the lookup service). Open — pre-validation + refund path would be
  cleaner; the lookup TODO calls this out.
- ⏳ **`buildReleaseProposal` TaPoS uses head, not LIB.** Unchanged; low probability
  given VIZ finality, noted for completeness.
- ⏳ **Coordinator counts unverified approvals.** Unchanged (liveness-only by design); a
  cheap local verify before counting would fail faster.

## 7. Engineering quality

- **Separation of concerns is genuinely good.** The `RemoteChain<MintProposal>`
  interface ([`adapters.ts`](../packages/common/src/adapters.ts)) keeps every SDK
  behind a narrow boundary; the core unit-tests with no network. Adding a chain is an
  adapter + watcher, not a core change — and Solana demonstrably slotted in that way.
- **Money math is integer milli-VIZ throughout** (bigint), no float — correct for a
  custody system.
- **Comments are placed at decision points** (TaPoS extraction, signature-set
  ordering, pause semantics) rather than narrating the obvious. The AGENTS.md "match
  the surrounding file" rule is visibly followed.
- **Tests are offline `node:assert` spikes** wired into `npm run verify`, not a
  framework (15 spikes now, incl. the new `outbox`, `fee-viz`, `dispatcher-policy`,
  `solana-innerix`, `pegout-address`). Pragmatic and CI-friendly but gives **no
  coverage signal**; the determinism it buys (no network) is right for the
  trust-critical paths.
- **Dependency hygiene** is documented and triaged in [`AGENTS.md`](../AGENTS.md)
  (accepted transitive advisories, the `ws` override, the TypeScript 5.x pin).

## 8. Recommended order of work before real value flows

Findings §6.1–§6.4 are now resolved and §6.5 is partly addressed (phases A–E,
[`improvements.md`](./improvements.md)). What remains before real value moves:

1. **Land the live mint/burn on-chain targets** — TON multisig-v2 `new_order`+`approve`;
   validate Solana mint + peg-out burn on devnet. The single largest "logic present,
   target missing" item.
2. **Lookup VIZ-account existence check** (§6.6) so deposit addresses / releases aren't
   issued to non-existent accounts.
3. **Height-range the burn scans** (§6.5) to be burst-complete, not page-limited.
4. **Devnet-validate the peg-out deposit-address flow** end-to-end (lookup → scan →
   burn-before-release → VIZ release).
5. **Harden fee-constant determinism** by embedding the fee policy in the committed
   federation manifest.

---
_Original findings were against static source at `835c7e0`; statuses reflect the phase
A–E changes. Full `npm run verify` runs on Linux CI (the `viz-js-lib` build is
Unix-only, so several services can't be built on Windows)._
