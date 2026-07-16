# R-1 — External Security Audit Package

**System:** viz-gateway — a federated M-of-N multisig bridge between the **VIZ**
blockchain (home chain, where native VIZ is locked/released) and remote chains
(**TON** live, **Solana** live) where wrapped VIZ (`wVIZ`) is minted/burned.

**Audit gate:** This document is the handoff package for the **R-1** external review —
the last open item before real value moves on mainnet. All prior audits (the internal
ed25519 review, R-4/R-6 hardening) are *internal* and are **not** a substitute for
independent third-party review.

**Commit under review:** `9b147bf` (main). Pin the exact hash with the auditor before
work starts; re-pin on any change.

**Prepared:** 2026-07-02. **Last refreshed:** 2026-07-11 — re-pinned `a25f425`→`9b147bf`
to cover the two post-pin security rounds (#36/#38, incl. the now-*enforced* Solana
upgrade-authority check and HTTP body-size limit), the at-rest keystore (#43), and the
full peg-out robustness + release-signature arc (#52/#54/#55/#56/#57). The **VIZ release
path changed materially** — async broadcast + poll-by-txid, and signature selection by
key recovery — so re-read §5.A. See §9 for the complete delta. Prior refresh (2026-07-05,
`a25f425`) covered the pre-audit sweep (#30), TON→GRAM rename (#31), and per-network
backing accounts (#32).

> **Naming note (read first):** the codebase uses **`GRAM`** as the internal
> `RemoteChainId` for the **TON** network — a historical rename (#31) of the chain
> identifier only. The **@ton/* SDK and `contracts/ton/` are unchanged**. So
> `packages/gram-watcher`, the `GRAM_*` env vars, and `RemoteChainId.GRAM` all refer to
> the live **TON** remote. This document says "TON" for the network and "GRAM" only when
> naming a code symbol.

---

## 0. How to use this document

1. Read §1–§3 for the system, the trust model, and the scope boundary.
2. Work §5 component-by-component; each row has the file(s) to read and the specific
   properties to check.
3. §4 is the threat model — the claims the whole design rests on. Every finding should
   map to breaking one of these.
4. §6 is build/repro; §7 is the requested deliverable format; §8 lists known accepted
   risks so you don't re-report them (challenge them if you disagree); §9 records the
   prior internal pre-audit and the fixes already merged.

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
- **Backing (per-network, #32):** locked VIZ is held in a **distinct gateway account per
  remote** — `gram.gate` (TON) and `solana.gate` (Solana) — an injective chain↔account
  registry (`packages/common/src/gatewayAccounts.ts`, fail-closed at construction on a
  duplicate or missing mapping). Each remote's circulating wVIZ is backed by its own
  account, and recon checks the peg **per chain** so a surplus on one remote can never mask
  under-backing on another (§5.D, T7).
- **Fee:** taken on the VIZ side, held in VIZ, swept to a single `fees.gate` account
  (`FEES_GATE_ACCOUNT`); mint is net. Peg-out and refunds are free. Money math is integer
  **milli-VIZ** (`bigint`), no floats.
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
| `packages/common` | **critical** | Chain-agnostic core: canonical digest, types, caps, fees, durable outbox + cap window + deposit-address registry (`store.ts`), per-network backing-account registry (`gatewayAccounts.ts`), threshold accumulation, operator rotation. |
| `packages/signer` | **holds keys** | The only key-holding service. Re-validates each proposal against an independently re-derived action (F2), then signs. One per operator. |
| `packages/coordinator` | **untrusted** | Builds one shared proposal, collects partials to threshold, broadcasts. Keyless on VIZ and TON. On **Solana** it holds the *submitter* key (`SOLANA_SUBMITTER_SECRET`) = fee payer + durable-nonce authority + ATA funder — **not** mint authority (that is the on-chain SPL multisig). Compromise → liveness stall (nonce grind / SOL drain), not theft. See §8. |
| `packages/viz-watcher` | read+sign | VIZ head-follow, peg-in detection, VIZ release signing/broadcast. |
| `packages/gram-watcher` | read+sign | TON finality + burn detection, TON mint-order approval. |
| `packages/solana-watcher` | read+sign | Solana adapter + PDA deposit-address derivation, lookup service, peg-out scanner, burn. |
| `packages/dispatcher` | keyless | Drains QUEUED outbox rows to the coordinator with retry/backoff; spawns FEE_SWEEP/REFUND children. |
| `packages/recon` | watchdog | Per-remote `locked(gate account) == circulating + unswept fees` (one `Recon` per chain, `checker.ts`); trips shared pause on under-backing. |
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
| T1 | A compromised coordinator cannot cause theft; worst case is liveness. (It is keyless on VIZ/TON; on Solana it holds only the *submitter* key — fee payer + nonce authority + ATA funder — never mint authority. See §2, §8.) | signer gates §1 | direct fund theft |
| T2 | Each signer re-derives the action from a finalized source event on its **own** node; coordinator-supplied fields never reach the chain reader. | `sourceValidator.ts` | forge a release for a non-existent/misattributed deposit |
| T3 | The canonical digest is a pure, unambiguous function of the source event, so honest operators produce byte-identical signable bytes. | `canonical.ts` | signature-splitting / a signer tricked into signing a different action than it validated |
| T4 | Every source event maps to exactly one action id; re-submission and crash-replay cannot double-mint/double-release. | `store.ts`, `sourceValidator.ts`, dispatcher recovery | double-mint / double-release |
| T5 | Funds at a Solana deposit PDA can only be **burned**, never transferred — no private key exists. | `gateway_deposit` program | single-party theft of in-transit peg-out funds |
| T6 | Active-set rotation changes only `active`/`regular` authority via a validated `account_update`; a co-signer never signs an authority other than the one claimed. | `rotation.ts`, `setup-viz/rotate.ts` | silent takeover via a malicious rotation |
| T7 | **Per-remote** `locked VIZ (that chain's gate account) == circulating wVIZ (that remote) + unswept fees`, checked independently per chain so a cross-chain surplus can't mask a shortfall; under-backing trips a shared pause. | `recon/checker.ts`, `recon/index.ts`, `gatewayAccounts.ts` | undetected over-mint / under-backing |
| T8 | Fee is a pure function of gross (operators agree independently); mint is net; below the gas floor → refund. | `fees.ts`, F2 fee re-derivation | fee disagreement stalls signing, or wrong net minted |

---

## 5. Component audit surface (with pointers)

### A. VIZ chain (home / lock-release)

| Area | File(s) | Check |
|---|---|---|
| Peg-in detection | `packages/viz-watcher/src/vizChain.ts` (`irreversibleDepositsSince`, `getDeposit`, `call`/`callOnce`) | Block-ranged scan (cap `MAX_BLOCKS_PER_SCAN`); confirms below `last_irreversible_block_num` (re-org safety); verifies `tx.transaction_id` matches (defends against a lying node); memo `"<chain>:<dest>"` fails closed on parse error. Every RPC has a per-call deadline (`RPC_TIMEOUT_MS`, #52) and bounded transient-only retry (`isTransientRpcError`, #55) so a flaky node slows the scan instead of hanging or resetting the window — application errors (unknown-tx) stay fail-fast/fail-closed. |
| Release signing | `packages/viz-watcher/src/vizSign.ts` | Per-operator secp256k1 partial over identical bytes; deterministic tx id (sha256, first 20 bytes). `recoverReleaseSigner` / `selectAuthoritySignatures` (#57) attribute each collected signature to its signer by secp256k1 recovery and pick a **minimal in-authority subset** (only keys in the account's `active_authority.key_auths`, up to `weight_threshold`, duplicates skipped) — robust to collection order and to a federation/authority mismatch during a rotation window. |
| Release broadcast | `packages/coordinator/src/adapters.ts` (`VizReleaseBroadcaster`), `vizChain.ts` (`broadcastRelease`, `activeAuthority`) | Threshold-met merge; **persist txid before send**. Broadcasts **async** then polls `confirmReleaseByTxId` for the deterministic id (~60s) — the sync broadcast 504s past ~20s inclusion lag (#54); attaches exactly the authority's minimal satisfying signature set and **fails closed** below `weight_threshold` (#56/#57), so an "irrelevant signature" can't silently drop the release. Idempotent: txid is a pure function of the unsigned proposal, so a retry is a chain no-op. |
| TaPoS | `vizChain.ts` (`buildReleaseProposal`) | Uses **head, not LIB** (accepted low-risk, §8); 60s expiry. |
| Active-set rotation | `packages/common/src/rotation.ts`, `setup-viz/src/rotate.ts` | `account_update` resets `active`+`regular` to sorted M-of-N keyset, **master omitted** (Graphene allows active-only change); co-sign validator re-derives the op and asserts JSON byte-equality; broadcaster re-checks live authority hash (anti-rollback). |
| Key custody | `packages/common/src/config.ts` (`VIZ_SIGNING_WIF`), `packages/signer/src/keyedSigner.ts` | Raw WIF in signer memory (scaffold; comment says production wraps HSM/KMS). Master assumed held offline. |

**Focus for auditor:** T2 (is the signer's VIZ node genuinely independent of coordinator
input?), T6 (rotation validator completeness — can a co-signer be induced to sign an
authority set different from the one it inspected?), the master-key operational
assumption (a leaked *active* WIF at T-of-N can rotate the active set; master compromise
is full takeover), and the new release **signature-selection** (`selectAuthoritySignatures`,
#57) — confirm the secp256k1 recovery correctly attributes each partial to its key over
the exact signed digest (`chain_id ++ toBuffer(trx)`), that only in-authority keys can
satisfy the threshold, and that the minimal-set trim can never drop a *required* signature.

### B. TON chain (remote / mint-burn)

| Area | File(s) | Check |
|---|---|---|
| Peg-in (burn) detection | `packages/gram-watcher/src/gramChain.ts` (`finalizedBurnsSince`) | Parses TEP-74 `internal_transfer` (op `0x178d4519`); finality via time-buffer from ~5s block cadence. **Scan is limit-windowed (last ~20 tx), not height-ranged** — burst beyond the page is missed (§8, partial). |
| Mint authorization | `gram-watcher/src/gramApprove.ts` (`GramApprover.approveMint`), `gramChain.ts` (`submitMint`), `gramSign.ts` | Multisig-v2 **on-chain** `new_order` + `approve` from each operator's own wallet (keyless coordinator, Phase B); off-chain ed25519 sigs collected but **not** the authorization path. 1-of-1 self-approves on init. |
| Idempotency | `gramChain.ts` (`orderExists`, `nextOrderSeqno`), coordinator `adapters.ts` (`actionExecuted`) | Persist-before-send; orphan recovery queries order existence. **Assumes a single proposer** — see risk below. |
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
| Mint / provenance | `contracts/solana/PROVENANCE.md`, `contracts/solana/src/deployMint.ts` | Program ID `MCFeMZJY…`; Anchor 1.1.2 / rustc 1.89.0 pinned. **Upgrade authority must be the M-of-N multisig** post-deploy — now **enforced in code** (`contracts/solana/src/enforceProgramAuthority.ts`, `programAuthority.ts`, #38), not just RUNBOOK prose; re-check the enforcement (does it fail closed if the on-chain upgrade authority isn't the expected multisig?), covered by `solana-upgrade-authority-spike.cjs`. |
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
| Recon | `packages/recon/src/{index,checker}.ts` | **One `Recon` per remote**: `locked(gatewayAccountₖ) ≥ circulating(k) + unswept fees(k)`; per-chain split so a surplus on one remote can't mask under-backing on another. Fatal on zero/missing expected remotes (VG-02); indeterminate (VIZ node or store down) fails closed after `maxConsecutiveFailures`; under-backing → `store.pause()`; SOL reserve monitor pages. Attack T7. |

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
  (~43 spikes incl. `signer-f2-spike`, `ton-pegout-f2-spike`, `idempotent-delivery-spike`,
  `deposit-pda-spike`, `pegout-guard-spike`, `lookup-validate-spike`,
  `fee-sweep-refund-spike`, `solana-upgrade-authority-spike` (#38 authority enforcement),
  `http-body-limit-spike` (#36 body cap), `viz-rpc-retry-spike` (#55) and
  `pegout-release-sigcount-spike` (#56/#57 — signs with real operator keys and asserts the
  minimal in-authority sig selection, incl. out-of-authority and duplicate cases), plus
  `contracts/ton/tools/verify-offline.cjs`). Deterministic, no network. Also a compiled
  unit-test target — `npm run test:unit` (65 tests) — run in CI (#38 BM1). Note the spikes
  are **pragmatic, give no coverage signal** — treat as behavior fixtures, not exhaustive.
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
- **TON burn scan** — *resolved (VG-06, main `42b1ca3`):* the scan is now `lt`-paginated from
  a durable anchor and **fails closed** when a burst exceeds `GRAM_MAX_SCAN_PAGES`, rather than
  silently truncating. Previously limit-windowed; verify the pagination/anchor logic.
- **TON single-proposer idempotency assumption** — order-seqno idempotency holds only
  with one proposer; multi-proposer would need action-id embedded in the order payload.
- **`VIZ_ACCOUNT_RE` is a loose pre-filter** — allows some Graphene-invalid shapes
  (`id`, `a.`, `a..b`); the authoritative gate is `accountExists`. Confirm the loose
  regex can't be leveraged before the existence check. Note the regex permits up to 32
  chars while the burn-only program guards `viz_account.len() <= 16`; the lookup now
  rejects >16-byte names at issuance (`MAX_VIZ_ACCOUNT_BYTES`, `lookupValidate.ts`) so it
  can never hand out an address whose release burn would revert on-chain and strand funds.
- **Coordinator holds the Solana *submitter* key** (`SOLANA_SUBMITTER_SECRET`): it is the
  fee payer, durable-nonce authority, and ATA funder for every Solana mint. It is **not**
  mint authority (that is the on-chain SPL M-of-N multisig), so it cannot mint, redirect,
  or inflate: each signer pins `mint`/`multisig`/`nonceAccount`/`feePayer` from its own
  config and re-derives NET before signing. The submitter key's blast radius is liveness
  only — grinding the durable nonce (invalidating a collected sig set) or draining its SOL
  (mints stall until refunded). The recon SOL-reserve monitor pages on the drain case. This
  is the one place T1's "keyless" shorthand is imprecise; the *no-theft* property still
  holds. (VIZ and TON are genuinely keyless on the coordinator.) `feePayer` is pinned by the
  signer only when `SOLANA_SUBMITTER_PUBKEY` is configured; a wrong fee payer otherwise
  fails the on-chain nonce advance (still liveness-only).
- **Encrypted peg-in memo support / gate memo key is a shared, non-fund secret.** VIZ
  memos may be encrypted to the gate account's memo key (`#`-prefixed); the watcher +
  signer decrypt them via `resolveMemoDestination` (`packages/viz-watcher/src/memo.ts`)
  using `VIZ_MEMO_WIF_*` before address validation. The memo key controls **no funds**
  (custody is the gram.gate 2-of-3 active authority) — its blast radius is *privacy*:
  a leak lets the holder decrypt/read (and forge) destination memos, never move VIZ.
  It is, however, a secret that must be **identical across all operators**: decryption
  is deterministic and the canonical digest binds the *resolved* recipient, so an
  operator missing/holding-a-wrong key resolves `""` and refuses — a liveness stall that
  ends in auto-refund, never a wrong-destination mint (proven in `viz-memo-decrypt-spike`).
  A malformed blob or wrong key fails closed to `""`. Same shared-config discipline as the
  fee config; sealed in the keystore alongside `VIZ_SIGNING_WIF` (co-located with a
  fund key, but strictly lower-value, so this widens no custody surface).
- **Coordinator counts approvals it hasn't locally verified** (liveness-only by design;
  the chain rejects bad merges).
- **Release proposal TaPoS uses head, not LIB** (low probability given VIZ finality).
- **Master VIZ authority assumed held offline** — active-set rotation deliberately omits
  master; a leaked active WIF at T-of-N can rotate active, master compromise is full
  takeover. This is an operational assumption, not enforced in code.
- **Single shared SQLite file** and **single coordinator instance** — data-integrity and
  liveness SPOFs respectively (no HA yet); neither enables theft.
- **Keys held locally by each operator (accepted; HSM/KMS not planned, decided 2026-07-06):**
  the custody control is the M-of-N federation, not per-box hardware — each operator's key lives
  only on that operator's own machine, under a separate person, so no external custody service is
  trusted and theft requires compromising T *independent* machines at once. Residual a single-box
  HSM would close = persistent exfiltration of *one* operator's key from a compromised box (valid
  until rotation); bounded by the threshold. Mitigation is **local at-rest encryption** — a
  cross-platform passphrase keystore so no plaintext WIF/mnemonic/secret sits on disk or in env
  files — which keeps keys on-box rather than moving them off it. The raw in-memory secret handling
  (Node strings can't be reliably zeroized) is in scope to review as-is.
- **`bigint-buffer@1.1.5` buffer overflow (GHSA-3gc7-fjrx-p6mg, high, no fix):** pulled
  transitively via `@solana/spl-token → @solana/buffer-layout-utils`. The package is
  unmaintained and `1.1.5` is the latest; there is no patched version to bump to. The
  overflow is in `toBigIntLE()` on malformed buffers — in this gateway it only decodes
  u64 amounts from on-chain account data and values we construct, not attacker-supplied
  network payloads, so it is not reachable via an untrusted input path. Accepted risk;
  the eventual fix is the `@solana/web3.js` v1 → v2 (`@solana/kit`) migration, which
  drops `bigint-buffer` entirely. `npm audit` surfaces this as 3 high entries that all
  collapse to this one root.
- **Dependabot ws/form-data alerts were false positives** — the lockfile has held
  `ws@8.21.0` (≥5.2.5) and `form-data@4.0.6` (patched) since the viz-js-lib pin; both
  alerts were dismissed as not-present. `npm audit` is clean for both.

---

## 9. Prior internal pre-audit & remediations (read before scoping)

An AI-driven internal dry-run of this scope was performed at commit `2cfb7cc` and is
recorded in **`docs/audit/R1-EXTERNAL-AUDIT-REPORT.md`** (explicitly *not* a substitute
for this engagement — a fictional firm name, no third-party attestation). It found 1 High,
5 Medium, 8 Low, 3 Info. **The High and all five Mediums have since been fixed and merged**;
each fix is annotated ✅ FIXED in that report and summarised here so they are not re-reported
as new (challenge the fixes if you disagree):

| Finding | Sev | Fix | main |
|---|---|---|---|
| VG-01 rotation multi-op injection (theft) | High | reject multi-op / non-empty-extensions proposals | `9094955` (#24) |
| VG-05 canonical encoding not injective | Med | length-prefixed encoding | `5387d6b` (#25) |
| VG-03 peg-in cursor skip | Med | durable cursor, cap-bounded advance | `42b1ca3` (#26) |
| VG-06 TON burn scan truncation | Med | `lt` pagination, fail-closed | `42b1ca3` (#26) |
| VG-02 recon fails open | Med | fail-closed on read error / missing remotes | `affb955` (#27) |
| VG-04 coordinator-authoritative fee sweep (backing drain) | Med | signer + dispatcher re-derive exact `base`; surcharge retained as surplus | `98d00a7` (#28) |

**VG-07…VG-17 (8 Low / 3 Info) remain open** as an accepted hardening backlog — see the
report's §3 for details.

### Changes since the dry-run (`2cfb7cc` → `a25f425`, this package's pin)

Beyond the six VG fixes above, three PRs landed after the internal dry-run and are covered
by this refreshed package — review them against the pinned head, not the dry-run commit:

| PR | Change | Audit-relevant effect |
|---|---|---|
| #30 (`41ec8c6`) | Pre-audit readiness sweep | T1 wording corrected (Solana submitter key = liveness, not "keyless"); lookup rejects >16-byte VIZ names at issuance (`MAX_VIZ_ACCOUNT_BYTES`); `feePayer` pinned when `SOLANA_SUBMITTER_PUBKEY` set; recon `RECON_EXPECTED_REMOTES`. All reflected in §5/§8. |
| #31 (`41a6244`) | TON→GRAM internal rename | `RemoteChainId`, env vars (`GRAM_*`), package `gram-watcher`, and symbols renamed. **@ton/* SDK and `contracts/ton/` unchanged.** See the naming note at the top. |
| #32 (`a25f425`) | Per-network backing accounts | Locked VIZ split into `gram.gate` / `solana.gate` via the injective `gatewayAccounts.ts` registry; recon is now per-chain (T7). New surface: `gatewayAccounts.ts` and its tests. |

### Changes since this package's prior pin (`a25f425` → `9b147bf`, 2026-07-11 refresh)

Seventeen PRs landed after the 07-05 pin. The audit-relevant ones are below. The remainder
— #40 (docker log-dir crash fix), #41 (caps/threshold unit tests), #42 & #53 (e2e-harness
GRAM drift fix / 3-of-3 live driver), #47 (Phase-1 handoff doc), #48–#51 (wVIZ token
name/logo/links + explorer decision) — are tooling, tests, harness, and off-chain token
metadata with no effect on the custody model; skim, don't scope.

| PR | main | Change | Audit-relevant effect |
|---|---|---|---|
| #36 | `03d6046` | Security round-1 (broad) | Adds an **HTTP request body-size limit** (`packages/common/src/http.ts`) guarding the signer/coordinator POST endpoints against oversized-payload DoS; a `seenRecovery.ts` crash-window helper; store/caps-ordering/Solana-read hardening and structured-log redaction. New surface: `http.ts`, `seenRecovery.ts`. |
| #38 | `7d4eec2` | Security round-2 (H3/M9) | **Solana upgrade-authority enforcement moved into code** (`contracts/solana/src/enforceProgramAuthority.ts`, `programAuthority.ts`) — §5.C's "must be the multisig" is now checked and fails closed, not merely documented; recon expected-remotes coverage (M9); CI now runs `test:unit`. Re-check §5.C against the enforcement, not the prose. |
| #43 | `dabf76c` | At-rest keystore | Cross-platform passphrase keystore (`packages/common/src/keystore.ts`, `tools/keystore.cjs`, config hydrate) so no plaintext WIF/mnemonic/secret sits on disk or in env files — already reflected in §8 key custody. Keys stay **on-box** (the M-of-N federation is the custody control; HSM/KMS deliberately not planned). |
| #52 | `0e5a2bd` | viz-watcher RPC timeout | Per-call deadline `RPC_TIMEOUT_MS` in `vizChain.ts call()`: a wedged VIZ transport is turned into a caught, retried error instead of hanging the scan loop silently. Liveness / self-heal. |
| #54 | `1b3a8fe` | Peg-out robustness | VIZ release **async broadcast + ~60s poll-by-txid** (`broadcastRelease`) to dodge the sync-broadcast 504 past ~20s inclusion lag; TON toncenter timeout raised (`GRAM_RPC_TIMEOUT_MS`, all 4 `GramHttpChain` sites); signer `/approve` timeout direction-aware `{pegIn:180s, pegOut:30s}`; dispatcher peg-in budget derived from it. Release-confirm correctness — see §5.A. |
| #55 | `1b05c91` | viz-watcher transient-RPC retry | `call()` splits into `callOnce()` + bounded exponential retry on **transient** LB failures only (`isTransientRpcError`: 5xx/429/socket/timeout); application errors (unknown-tx) stay fail-fast and fail-closed for `getDeposit`/`confirmReleaseByTxId`. Broadcast retry is safe (deterministic txid + dedupe). Verify the transient/non-transient classification. |
| #56 | `84d644b` | Release signature count | `broadcastRelease` attaches exactly the VIZ authority's `weight_threshold` signatures (the federation may collect more than the account's authority needs) and **fails closed** below it — otherwise graphene silently drops the async release as an "irrelevant signature included". |
| #57 | `9b147bf` | Release sig selection by key recovery | Supersedes #56's order-trusting `slice()`: partials are attributed to their signer via secp256k1 recovery and a **minimal in-authority subset** is chosen (out-of-authority sigs and duplicates skipped), robust to a federation/authority mismatch mid-rotation. New pure helpers `recoverReleaseSigner` / `selectAuthoritySignatures` in `vizSign.ts` — new crypto surface for T3/T6 (see §5.A focus). |

---

_This package supersedes the whole-system scope of R-1. The retired-crypto internal
review remains at `docs/audit-ed25519-additive-derivation.md` for historical context
only. Re-pin the commit hash with the auditor before the engagement begins (the internal
pre-audit is at `2cfb7cc`; the current head `9b147bf` includes the six VG fixes, PRs
#30/#31/#32, and the post-pin security + peg-out changes #36/#38/#43/#52/#54/#55/#56/#57
tabled above)._
