# R-1 — External Security Audit Package

**System:** viz-gateway — a federated M-of-N multisig bridge between the **VIZ**
blockchain (home chain, where native VIZ is locked/released) and remote chains
(**TON** live, **Solana** live) where wrapped VIZ (`wVIZ`) is minted/burned.

**Audit gate:** This document is the handoff package for the **R-1** external review —
the last open item before real value moves on mainnet. All prior audits (the internal
ed25519 review, R-4/R-6 hardening) are *internal* and are **not** a substitute for
independent third-party review.

**Commit under review:** `01bd1ad` (main). Pin the exact hash with the auditor before
work starts; re-pin on any change.

**Prepared:** 2026-07-02.

---

## 0. How to use this document

1. Read §1–§3 for the system, the trust model, and the scope boundary.
2. Work §5 component-by-component; each row has the file(s) to read and the specific
   properties to check.
3. §4 is the threat model — the claims the whole design rests on. Every finding should
   map to breaking one of these.
4. §6 is build/repro; §7 is the requested deliverable format; §8 lists known accepted
   risks so you don't re-report them (challenge them if you disagree).

The **defining invariant to attack**: the orchestrator holds no keys and every signer
independently re-derives what it signs from a finalized source event on *its own* node.
If you can make an honest signer authorize a payment that does not correspond to a real,
finalized, correctly-attributed source event — that is the headline finding.

---

## 1. System overview

- **Peg-in:** lock VIZ on VIZ → mint `wVIZ` (net of a VIZ-side fee) on the remote chain.
- **Peg-out:** send `wVIZ` back on the remote chain (burn) → release VIZ on VIZ.
  - **TON** routes by on-chain memo (VIZ recipient in the forward payload).
  - **Solana** has no usable memo, so routing is by a deterministic per-VIZ-account
    **PDA deposit address** (see §5.C). The address a burn originates from *is* the
    routing identity.
- **Fee:** taken on the VIZ side, held in VIZ, swept to a `fees.gate` account; mint is
  net. Peg-out and refunds are free. Money math is integer **milli-VIZ** (`bigint`),
  no floats.
- **Federation:** default target **5-of-7** (BFT-clean for f=2); bootstraps at **1-of-1**
  and grows with no redeploy.

### Trust model in one read

```
 source event (finalized)              each operator, independently
        │                                        │
        ▼                                        ▼
 watcher detects ──► enqueue (durable outbox) ──► dispatcher ──► coordinator builds
 (idempotency first-claim,   (action = GROSS,                    ONE proposal (net,
  caps → HELD or QUEUED)      deterministic digest)              pinned provisioning)
        │                                                        ├─► signer #1: re-read
        │                                                        │   source on its OWN
        ▼                                                        │   node, re-derive
   POST /submit ────────────────────────────────────────────────┤   action, compare,
                                                                 │   sign → partial
                                                                 ├─► signer #2 … (until T)
                                                                 ▼
                                                    broadcast merged sigs; the CHAIN
                                                    enforces the real M-of-N authority
```

Two independent custody gates:
1. **Per-signer validation** (`packages/signer/src/sourceValidator.ts`,
   `keyedSigner.ts`): each signer checks recipient/amount/id/digest against the action
   *it* derived from the source event before signing.
2. **On-chain authority**: merged signatures must satisfy the real M-of-N authority on
   VIZ/TON/Solana. Forged or under-threshold approvals fail at broadcast — a liveness
   event, never theft.

---

## 2. Component map & trust levels

| Package | Trust | Role |
|---|---|---|
| `packages/common` | **critical** | Chain-agnostic core: canonical digest, types, caps, fees, durable outbox + cap window + deposit-address registry (`store.ts`), threshold accumulation, operator rotation. |
| `packages/signer` | **holds keys** | The only key-holding service. Re-validates each proposal against an independently re-derived action (F2), then signs. One per operator. |
| `packages/coordinator` | **untrusted / keyless** | Builds one shared proposal, collects partials to threshold, broadcasts. Compromise → liveness stall, not theft. |
| `packages/viz-watcher` | read+sign | VIZ head-follow, peg-in detection, VIZ release signing/broadcast. |
| `packages/ton-watcher` | read+sign | TON finality + burn detection, TON mint-order approval. |
| `packages/solana-watcher` | read+sign | Solana adapter + PDA deposit-address derivation, lookup service, peg-out scanner, burn. |
| `packages/dispatcher` | keyless | Drains QUEUED outbox rows to the coordinator with retry/backoff; spawns FEE_SWEEP/REFUND children. |
| `packages/recon` | watchdog | `locked == circulating + unswept fees` across all remotes; trips shared pause on under-backing. |
| `contracts/solana` | on-chain | `gateway_deposit` burn-only Anchor program (§5.C). |
| `contracts/ton` | on-chain | Multisig-v2 + Jetton minter BOCs + rotation (§5.B). |
| `setup-viz` | tooling | VIZ account setup + operator-rotation CLI. |

---

## 3. Scope

### In scope (whole cross-chain system)

- **Cryptographic / consensus-critical:** canonical action encoding & digest
  (`packages/common/src/canonical.ts`), threshold accumulation & rotation
  (`rotation.ts`), the Solana `gateway_deposit` Anchor program, PDA derivation and F2
  re-derivation, VIZ `account_update` active-set rotation, TON multisig-v2 order/approve.
- **Custody & authorization:** the two-gate model (§1), signer F2 source-validation for
  every action type (PEG_IN, Solana/TON PEG_OUT, FEE_SWEEP, REFUND), key custody and
  isolation.
- **Correctness / safety:** idempotency & double-mint prevention across all three chains,
  crash-window recovery, the backing invariant (recon), caps/circuit-breaker, pause
  semantics.
- **Operational:** config/secret model (`.env.example`, `config.ts`), deploy/upgrade
  authority handoff (RUNBOOK §5), provenance of deployed bytecode
  (`contracts/*/PROVENANCE.md`).

### Out of scope

- **Retired code:** the additive-ed25519 deposit-key derivation and raw-scalar signer
  (Variant A) were **removed in R-6** (PR #16) and replaced by the keyless PDA design.
  The internal review `docs/audit-ed25519-additive-derivation.md` is retained for
  history only and describes code that **no longer exists** on `main`. Do not audit it;
  confirm its absence instead (see §5.C, property 6).
- Upstream SDKs and their advisories triaged in `AGENTS.md` (viz-js-lib, `ws` override,
  TypeScript pin) — note if you disagree with the triage, but they are accepted.
- The upstream TON `multisig-contract-v2` and `token-contract` bytecode themselves —
  their **provenance/pinning** is in scope (§5.B), their internal correctness is the
  upstream projects' audits.

---

## 4. Threat model — the claims to attack

| # | Claim the design makes | Where it lives | If false → |
|---|---|---|---|
| T1 | A keyless coordinator cannot cause theft; worst case is liveness. | signer gates §1 | direct fund theft |
| T2 | Each signer re-derives the action from a finalized source event on its **own** node; coordinator-supplied fields never reach the chain reader. | `sourceValidator.ts` | forge a release for a non-existent/misattributed deposit |
| T3 | The canonical digest is a pure, unambiguous function of the source event, so honest operators produce byte-identical signable bytes. | `canonical.ts` | signature-splitting / a signer tricked into signing a different action than it validated |
| T4 | Every source event maps to exactly one action id; re-submission and crash-replay cannot double-mint/double-release. | `store.ts`, `sourceValidator.ts`, dispatcher recovery | double-mint / double-release |
| T5 | Funds at a Solana deposit PDA can only be **burned**, never transferred — no private key exists. | `gateway_deposit` program | single-party theft of in-transit peg-out funds |
| T6 | Active-set rotation changes only `active`/`regular` authority via a validated `account_update`; a co-signer never signs an authority other than the one claimed. | `rotation.ts`, `setup-viz/rotate.ts` | silent takeover via a malicious rotation |
| T7 | `locked VIZ == circulating wVIZ (all remotes) + unswept fees`; under-backing trips a shared pause. | `recon` | undetected over-mint / under-backing |
| T8 | Fee is a pure function of gross (operators agree independently); mint is net; below the gas floor → refund. | `fees.ts`, F2 fee re-derivation | fee disagreement stalls signing, or wrong net minted |

---

## 5. Component audit surface (with pointers)

### A. VIZ chain (home / lock-release)

| Area | File(s) | Check |
|---|---|---|
| Peg-in detection | `packages/viz-watcher/src/vizChain.ts` (`irreversibleDepositsSince`, `getDeposit`) | Block-ranged scan (cap `MAX_BLOCKS_PER_SCAN`); confirms below `last_irreversible_block_num` (re-org safety); verifies `tx.transaction_id` matches (defends against a lying node); memo `"<chain>:<dest>"` fails closed on parse error. |
| Release signing | `packages/viz-watcher/src/vizSign.ts` | Per-operator secp256k1 partial over identical bytes; deterministic tx id (sha256, first 20 bytes). |
| Release broadcast | `packages/coordinator/src/adapters.ts` (`VizReleaseBroadcaster`) | Threshold-met merge; **persist txid before send**; recovery via `confirmReleaseByTxId`. |
| TaPoS | `vizChain.ts` (`buildReleaseProposal`) | Uses **head, not LIB** (accepted low-risk, §8); 60s expiry. |
| Active-set rotation | `packages/common/src/rotation.ts`, `setup-viz/src/rotate.ts` | `account_update` resets `active`+`regular` to sorted M-of-N keyset, **master omitted** (Graphene allows active-only change); co-sign validator re-derives the op and asserts JSON byte-equality; broadcaster re-checks live authority hash (anti-rollback). |
| Key custody | `packages/common/src/config.ts` (`VIZ_SIGNING_WIF`), `packages/signer/src/keyedSigner.ts` | Raw WIF in signer memory (scaffold; comment says production wraps HSM/KMS). Master assumed held offline. |

**Focus for auditor:** T2 (is the signer's VIZ node genuinely independent of coordinator
input?), T6 (rotation validator completeness — can a co-signer be induced to sign an
authority set different from the one it inspected?), and the master-key operational
assumption (a leaked *active* WIF at T-of-N can rotate the active set; master compromise
is full takeover).

### B. TON chain (remote / mint-burn)

| Area | File(s) | Check |
|---|---|---|
| Peg-in (burn) detection | `packages/ton-watcher/src/tonChain.ts` (`finalizedBurnsSince`) | Parses TEP-74 `internal_transfer` (op `0x178d4519`); finality via time-buffer from ~5s block cadence. **Scan is limit-windowed (last ~20 tx), not height-ranged** — burst beyond the page is missed (§8, partial). |
| Mint authorization | `tonChain.ts` (`submitMint`), `tonSign.ts` | Multisig-v2 **on-chain** `new_order` + `approve`; off-chain ed25519 sigs collected but **not** the authorization path. 1-of-1 self-approves on init. |
| Idempotency | `tonChain.ts` (`actionExecuted`, `orderExists`, `nextOrderSeqno`) | Persist-before-send; orphan recovery queries order existence. **Assumes a single proposer** — see risk below. |
| Deployed bytecode | `contracts/ton/boc/PROVENANCE.md` | Multisig from `multisig-contract-v2 @ 9a4b13d…`, minter/wallet from `token-contract @ 1182ad9`; cell hashes pinned; rebuilt via `blueprint build`. Verify hashes match the deployed contracts. |
| Rotation | `contracts/ton/src/rotateTon.ts` | `update_multisig_params` as a multisig order; each signer re-validates the order cell byte-for-byte before `approve`. No master/active split on TON. |

**Focus for auditor:** the single-proposer idempotency assumption (T4 on TON — could a
second proposer or a rogue actor consume order seqno N with a different action, breaking
the idempotency key?); the limit-windowed burn scan (T4/liveness — missed burns);
minter admin handoff is **one-way** (multisig dysfunction ⇒ wVIZ permanently locked);
finality buffer assumes stable block time.

### C. Solana chain (remote / mint-burn, zero-trust peg-out custody)

| Area | File(s) | Check |
|---|---|---|
| **Burn-only program** | `contracts/solana/programs/gateway-deposit/src/lib.rs` | `burn_deposit` is the **only** instruction — no transfer path. PDA `["deposit", viz_account]` authority; `viz_account.len() ≤ 16` on-chain guard (Graphene name limit); Token-2022 burn CPI with PDA signer seeds. |
| PDA deposit address | `packages/solana-watcher/src/depositAddress.ts` | `depositPubkey/Address/Ata` derive `PDA(["deposit", vizAccount_utf8], programId)` — **no private key anywhere**; `buildBurnDepositIx` encodes `(viz_account, amount)`. |
| F2 re-derivation | `packages/signer/src/sourceValidator.ts` (Solana PEG_OUT branch) | Re-reads burn on operator's own node; looks up `store.depositAddressBy(burn.from)`; **re-derives** the PDA from `vizAccount + SOLANA_DEPOSIT_PROGRAM_ID` and asserts it equals the burn source (a tampered registry cannot pass). |
| Lookup issuance gate | `packages/solana-watcher/src/lookupValidate.ts`, `lookup.ts` | Issues a deposit address only if `VizChain.accountExists` (non-existent → 404; VIZ node outage → fail-closed 500). Note `VIZ_ACCOUNT_RE` is a **loose** pre-filter (§8). |
| Mint / provenance | `contracts/solana/PROVENANCE.md`, `contracts/solana/src/deployMint.ts` | Program ID `MCFeMZJY…`; Anchor 1.1.2 / rustc 1.89.0 pinned. **Upgrade authority must be set to the M-of-N multisig** post-deploy (RUNBOOK §5) — verify. |
| Operator rotation | `contracts/solana/src/rotateSolana.ts` | Two-phase SPL multisig handoff. |

**Focus for auditor:** T5 — confirm there is genuinely no transfer/withdraw path
(program upgrade authority is the only escape hatch, hence the multisig-upgrade-authority
requirement); PDA seed collision / `viz_account` canonicalization (UTF-8 bytes, ≤16
guard — can two distinct VIZ names collide, or a name be spoofed?); the F2 registry
re-derivation (T2/T5); reproducible build of the `.so` vs the deployed program hash.

**Property 6 (retired-code check):** confirm no additive-ed25519 derivation, raw-scalar
signer, `masterScalar`, `deriveDepositSigner`, `SOLANA_DEPOSIT_MASTER_SEED`, or
`DEPOSIT_MASTER_PUB` remain reachable on `main`. Their removal is the core of R-6; a
lingering reference would reintroduce the F-1 "one child scalar ⇒ master compromise"
blast radius.

### D. Orchestration, idempotency & state

| Area | File(s) | Check |
|---|---|---|
| Canonical digest | `packages/common/src/canonical.ts` | Fixed field order, explicit separators (no JSON ambiguity); `remoteChain` committed into the peg-in digest (target can't be swapped). Attack T3. |
| Durable outbox | `packages/common/src/store.ts` | `node:sqlite` (WAL, 10s busy timeout), shared single file. `enqueue` = atomic `INSERT OR IGNORE` first-claim. FSM `SEEN→QUEUED→SIGNING/BROADCAST→CONFIRMED`, `HELD`, `REFUNDING→REFUNDED`, `FAILED`. `id TEXT PRIMARY KEY` = canonical action id. |
| Dispatcher recovery | `packages/dispatcher/src/index.ts` | Marks BROADCAST before coordinator call; orphaned BROADCAST rows past timeout requeue; coordinator `actionExecuted()` short-circuits if the action already landed on-chain. Attack T4. |
| F2 all action types | `packages/signer/src/sourceValidator.ts` | PEG_IN (re-read VIZ deposit), Solana/TON PEG_OUT (re-read burn), FEE_SWEEP (recipient == own `feesGateAccount`, amount within `[base, base+surcharge]`), REFUND (recipient == `deposit.from`, exact amount). Dispatch by source-id **shape**, not coordinator field. All failures → `SourceMismatchError`, fail-closed. |
| Fees | `packages/common/src/fees.ts`; `setFee`/`persistFee` | `base = max(10 VIZ, 0.20%)` + per-chain activation surcharge; net = gross − fee; below gas floor → refund. Fee persisted at proposal-build time (survives lost response). BigInt sums (no 2⁶³ overflow). |
| Caps / pause | `packages/common/src/caps.ts`, `store.ts` | Per-tx + rolling-24h in shared `cap_window` (cross-process, survives restart); 24h breach trips pause. Pause 1-of-N to trip, deliberate to clear; signer returns HTTP 423. |
| Recon | `packages/recon/src/index.ts` | Sums circulating across **all** remotes + unswept fees vs locked; under-backing → `store.pause()`; SOL reserve monitor pages. Attack T7. |

**Focus for auditor:** T3 (any canonical-encoding ambiguity or field a malicious
coordinator can vary while keeping the same digest); T4 (the crash windows between
persist/send/confirm on each chain); the shared SQLite file as a single point of
data-integrity failure.

---

## 6. Build, test & reproduce

- **Runtime:** Node `>=20` (store uses `node:sqlite`, needs a build with it enabled;
  CI is Linux — the `viz-js-lib` git dep build script is Unix-only, so some services
  won't `tsc`-build on Windows).
- **Install & build:** `npm ci` then `npm run build` (`tsc -b` across the workspaces in
  `package.json` → `packages/*`, `contracts/ton`, `contracts/solana`, `setup-viz`,
  `tools/e2e`).
- **Test suite = offline `node:assert` spikes** wired into **`npm run verify`**
  (~25 spikes incl. `signer-f2-spike`, `ton-pegout-f2-spike`, `idempotent-delivery-spike`,
  `deposit-pda-spike`, `pegout-guard-spike`, `lookup-validate-spike`,
  `fee-sweep-refund-spike`, plus `contracts/ton/tools/verify-offline.cjs`). Deterministic,
  no network. Note: **pragmatic, gives no coverage signal** — treat as behavior fixtures,
  not exhaustive.
- **Anchor program:** `contracts/solana` — Anchor `1.1.2`, rustc `1.89.0`
  (`rust-toolchain.toml`). Reproducible-build the `.so` and diff against the deployed
  program at `MCFeMZJY…`.
- **On-chain proofs on record (internal, for context):** VIZ prod active-set rotation
  round-trip; TON testnet peg-in+peg-out incl. crash-window re-proof; Solana devnet
  mint + peg-out burn. See `RUNBOOK.md` (verification records, §5 deploy checklist).
- **Config/secret model:** `.env.example` (documented) + `packages/common/src/config.ts`.
  Secrets are env/file-loaded at startup, no live re-read.

---

## 7. Requested deliverable

For each finding: **severity** (Critical/High/Med/Low/Info), **component + file:line**,
**which threat-model claim (§4) it breaks**, a **concrete exploit or failure scenario**,
and a **recommended fix**. A short **verdict** on whether the two-gate custody model
(T1/T2) holds as designed. Explicitly call out anything in §8 you believe is
under-rated.

---

## 8. Known / accepted risks (don't re-report as new — challenge if you disagree)

- **F-1 blast radius (retired):** the old additive scheme's "one child scalar ⇒ master
  compromise" is **gone with the code** (R-6 → PDA, no private key). Verify absence.
- **TON burn scan is limit-windowed, not height-ranged** — burst beyond the page can be
  missed (liveness/completeness, not theft). Partially addressed; noted in
  `docs/overview.md §6.5`.
- **TON single-proposer idempotency assumption** — order-seqno idempotency holds only
  with one proposer; multi-proposer would need action-id embedded in the order payload.
- **`VIZ_ACCOUNT_RE` is a loose pre-filter** — allows some Graphene-invalid shapes
  (`id`, `a.`, `a..b`); the authoritative gate is `accountExists`. Confirm the loose
  regex can't be leveraged before the existence check.
- **Coordinator counts approvals it hasn't locally verified** (liveness-only by design;
  the chain rejects bad merges).
- **Release proposal TaPoS uses head, not LIB** (low probability given VIZ finality).
- **Master VIZ authority assumed held offline** — active-set rotation deliberately omits
  master; a leaked active WIF at T-of-N can rotate active, master compromise is full
  takeover. This is an operational assumption, not enforced in code.
- **Single shared SQLite file** and **single coordinator instance** — data-integrity and
  liveness SPOFs respectively (no HA yet); neither enables theft.
- **Keys in signer process memory** (scaffold) — production intends HSM/KMS
  (`keyedSigner.ts` comment); the raw secret handling is in scope to review as-is.

---

_This package supersedes the whole-system scope of R-1. The retired-crypto internal
review remains at `docs/audit-ed25519-additive-derivation.md` for historical context
only. Re-pin the commit hash with the auditor before the engagement begins._
