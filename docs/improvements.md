# Gateway improvements — implementation record

What was implemented across phases A–E, why, and how it was verified. Builds on
the review in [`docs/overview.md`](./overview.md) (findings referenced as §6.x).

Patterns here were adapted from a separate reference Solana wallet-service (a
custodial single-hot-wallet design); only the **chain-agnostic mechanics**
(transaction parsing, RPC throttling, a durable queue state machine, deterministic
address derivation, structured logging) were reused — never the single-key signing,
which is incompatible with this gateway's **M-of-N multisig**. The multisig basis is
untouched: the coordinator holds no keys, signers independently validate, and every
VIZ transfer out of the gateway account is T-of-N.

## Verification status

- **Fully built + spike-verified locally** (no network): `common`, `log`,
  `dispatcher`, `solana-watcher`, `ton-watcher`.
- New offline spikes (in `npm run verify`): `solana-innerix`, `outbox`,
  `dispatcher-policy`, `fee-viz`, `pegout-address` — all green.
- `signer` / `coordinator` / `recon` / `viz-watcher` compile on CI but **not
  locally**: the `viz-js-lib` git dependency builds its `lib/` with a Unix-only
  script (`rm`/`webpack`/`gzip`/`du`) that fails on Windows, so `npm install` needs
  `--ignore-scripts` here and those packages can't be `tsc`-built. Their changes are
  backward-compatible; the existing VIZ/Solana spikes were updated to the new APIs
  and run on Linux CI.

---

## Phase A — Solana read-path correctness & resilience ✅

**A1 — innerInstructions parsing (§6.5).** [`parseGatewayDeposit`](../packages/solana-watcher/src/solanaChain.ts)
now scans top-level **and `meta.innerInstructions`**, both `transfer` and
`transferChecked` (+ `spl-token-2022`). _Why:_ transfers routed through a program
(CPI — swap routers/aggregators) live in inner instructions; the old top-level-only
scan silently lost them → lost user funds. Spike: `tools/solana-innerix-spike.cjs`.

**A2 — RPC throttle + pagination.** `SolanaChain` takes `SolanaScanOpts`
(`maxSignatures`, `txDelayMs`, with a `sleep` between `getParsedTransaction`); TON
gets `TON_MAX_TRANSACTIONS`. _Why:_ the burn scan looped RPC with no pause and a
hardcoded limit → 429s on real/free-tier RPC. Config: `SOLANA_MAX_SIGNATURES`,
`SOLANA_RPC_TX_DELAY_MS`, `TON_MAX_TRANSACTIONS`.

**A3 — confirm after broadcast.** `SolanaChain.submitMint` now polls
`getSignatureStatus` to confirmation (durable-nonce txs have no blockhash expiry, so
status polling, not a blockhash strategy). _Why:_ a dropped tx was treated as a
successful mint.

## Phase B — durable outbox + dispatcher ✅

**B1 — `action_outbox` + cap window (§6.3, §6.4).** [`store.ts`](../packages/common/src/store.ts)
replaces the thin `processed_actions` ledger with a full `action_outbox` (the action
payload + a delivery state machine) plus a shared `cap_window` table. _Why:_ the old
flow claimed an id then dropped the action on any failed submit (stuck at `SEEN`
forever); and the 24h cap lived in process memory (reset on restart → bypassable).
State machine: `SEEN → QUEUED → SIGNING → BROADCAST → CONFIRMED`, with `HELD`
(caps/min), `REFUNDING → REFUNDED`, and terminal `FAILED`.

**B2 — dispatcher process.** New [`packages/dispatcher`](../packages/dispatcher/src):
watchers now only **enqueue**; the dispatcher drains `QUEUED` rows to the coordinator
with retry/backoff. _Why:_ decouples "detected an action" (durably persisted) from
"delivered it" (retried), surviving coordinator/network hiccups and restarts. Pure
[`policy.ts`](../packages/dispatcher/src/policy.ts) is spike-tested.

**B3 — HELD instead of silent drop.** All three watchers enqueue then, on
caps/minimum failure, set `HELD` (not `continue`). The 24h breach still trips the
shared pause.

**B4 — shared 24h cap window.** `CircuitBreaker` reads/writes the cap window via the
store. Spike: `tools/outbox-spike.cjs` (idempotent enqueue, HELD persistence,
backoff `due`, unswept-fee accounting, window survives reopen).

## Phase C — fee on the VIZ side ✅

**Decision:** the peg-in fee is taken on VIZ and **held in VIZ**; we mint **NET**
(gross − fee). Peg-out and refunds are free.

**C1 — gross in the action, net at proposal build.** [`canonicalPegIn`](../packages/common/src/canonical.ts)
commits **gross** (immutable source amount); the coordinator computes net.
[`fees.ts`](../packages/common/src/fees.ts): `base = max(10 VIZ, 0.20%)` (crossover at
5,000 VIZ) + per-chain activation surcharge; `net = gross − fee`; reject (→ refund)
if net can't clear the mint-gas floor. _Why §6.1:_ the fee was computed then ignored
(gross minted). Spike: `tools/fee-viz-spike.cjs`.

**C2 — determinism.** `base` is a pure function of gross, so every operator derives
the same net; the signer ([`keyedSigner.ts`](../packages/signer/src/keyedSigner.ts))
re-derives base and asserts `proposal.net == gross − base − activation`. Fee constants
live in shared config (must be identical across operators).

**C5 — activation surcharge (pinned, race-free).** `RemoteChain.isDestinationProvisioned`
(Solana ATA exists / TON jetton-wallet deployed) is read **once** by the coordinator
and pinned as `destProvisioned` in the proposal; the signer accepts the boolean but
verifies the net arithmetic. _Why:_ reading the flag per-operator would race (the ATA
can be created between reads) → divergent net → signatures wouldn't merge. A wrong
flag only shifts ≤ the surcharge between the user and `fees.gate` — never the backing.

**C3 — fee sweep to `fees.gate` per peg-in.** On a confirmed PEG_IN the dispatcher
spawns a `FEE_SWEEP` (a VIZ release of the fee to the single-key `fees.gate` account,
reusing the release path). On delivery-window exhaustion it spawns a `REFUND` (gross
back to the original VIZ sender). Both are T-of-N; if the federation is too degraded
to sign even the refund, the row stays `REFUNDING` (funds recoverable on recovery).
Spike: `tools/dispatcher-policy-spike.cjs`.

**C4 — recon: multi-remote + unswept fees (§6.2).** [`recon`](../packages/recon/src/index.ts)
now sums circulating wVIZ across **every** configured remote (TON + Solana) and checks
`locked == circulating + unsweptFees` — over-backing is safe; only `circulating > locked`
(under-backing) trips the pause. _Why:_ recon previously compared against TON supply
only (would mask a Solana over-mint) and flagged any drift in both directions.

## Phase D — ops ✅

- **D1/D4 — structured logging + `notifyStaff`.** New [`packages/log`](../packages/log/src)
  (winston, daily rotation, module tags), kept out of `common` (dependency-light rule).
  `notifyStaff(scope, message)` is a loud red log now; the interface is ready for a
  real channel (Telegram/PagerDuty) later without touching call sites.
- **D2 — graceful shutdown.** Watchers, dispatcher, recon, signer, and coordinator
  handle SIGINT/SIGTERM and close the store / server cleanly.
- **D3 — reserve monitor.** Recon pages (`notifyStaff`) when the Solana submitter SOL
  balance drops below `SOLANA_SUBMITTER_MIN_LAMPORTS` (it pays fee + ATA rent per mint;
  if it runs dry, mints silently fail).

## Phase E — Solana peg-out via deposit addresses (Variant A) ✅ core / scanner wired

Solana has no native memo and Phantom's send UI can't attach one, so the
"send wVIZ + memo" model is unusable for retail. Instead each VIZ account gets a
deterministic Solana deposit address; funds arriving there are released to that VIZ
account — the **address is the routing identity**, no memo needed.

- **E1 — deterministic derivation.** [`depositAddress.ts`](../packages/solana-watcher/src/depositAddress.ts):
  originally `X = HMAC-SHA512(MASTER_SEED, vizAccount)[:32] → Keypair.fromSeed`. The
  `MASTER_SEED` is a single hot key **outside the multisig** (like `fees.gate`): it can
  only burn the transient wVIZ on these addresses, never mint or touch the VIZ backing.
  Spike: `tools/pegout-address-spike.cjs`. **(Superseded by F2 below: now additive ed25519
  so signers re-derive from a PUBLIC master key; the address changes — clear the table.)**
- **E2 — lookup service.** [`lookup.ts`](../packages/solana-watcher/src/lookup.ts):
  `GET /address?viz_account=alice → { address, ata, mint, warning }`. Stateless
  derivation; open/unauthenticated (release is bound to derivation → a third party can
  only gift, never redirect). Warns to send only wVIZ on Solana. Confirms the VIZ account
  exists on-chain (`VizChain.accountExists`, a `get_accounts` read) before issuing +
  registering — a typo'd/non-existent account is rejected 404 (peg-out never refunds, so
  wVIZ sent there would be stuck); the regex is a cheap pre-filter and a VIZ node outage
  fails closed (500, no unverified issue).
- **E3 — registry.** `deposit_addresses` table + store methods (register / lookup by
  address-or-ATA / scan-rotation by `scan_time`). _Why:_ derivation is stateless but
  the scanner needs the finite set of issued addresses to watch.
- **E4 — scanner.** [`pegoutScanner.ts`](../packages/solana-watcher/src/pegoutScanner.ts):
  rotates registered addresses, detects finalized incoming wVIZ, and enqueues PEG_OUT.
- **E5 — burn-before-release.** `SolanaChain.burnFromDeposit` burns the received wVIZ
  **before** the VIZ release, so supply drops first (over-backing window — the safe
  direction); releasing first would briefly under-back and trip recon.

_Status:_ derivation + registry are spike-verified; the lookup service, scanner, and
burn are implemented and build, but their on-chain behaviour needs devnet validation.

## PR #2 review follow-ups

**#1 — peg-out validate-before-burn (🔴 permanent fund loss) ✅.** The deposit-address
scanner ([`pegoutScanner.ts`](../packages/solana-watcher/src/pegoutScanner.ts)) burned
wVIZ before checking the release target existed and applied no caps — so a peg-out to a
non-existent/typo'd VIZ account burned the wVIZ with no release and (per Phase C, PEG_OUT
never refunds) no recovery: permanent user loss. Now, after the `SEEN` claim and **before**
the burn, it runs the rolling `CircuitBreaker` caps **and** a VIZ account-existence check
(`VizChain.accountExists`, new — `getAccounts` non-empty). On any failure the row parks in
`HELD` (wVIZ stays un-burned in the deposit ATA, recoverable); `OVER_24H` trips the shared
pause. The decision is a pure [`guardPegOut`](../packages/solana-watcher/src/pegoutGuard.ts)
(caps before existence; existence RPC skipped when caps fail). This makes the lookup-time
existence check (Phase E2 TODO) defense-in-depth rather than the real gate. Spike:
`tools/pegout-guard-spike.cjs`.

**#2 stopgap — per-direction `signingTimeoutMs` ✅.** `DISPATCHER_SIGNING_TIMEOUT_MS` split
into `…_PEG_IN_MS` (default 300s) / `…_PEG_OUT_MS` (180s); the dispatcher applies the
per-direction threshold to each orphaned `SIGNING` row so a slow-but-legit mint confirm
isn't spuriously requeued. This only narrows the window — the real idempotent-delivery fix
is planned separately.

**#3 — peg-out burn-checkpoint recovery (🟠) ✅.** The scanner now writes the burn
signature onto the row (`txid`, still `SEEN`) **before** the `QUEUED` hand-off
([`pegoutScanner.ts`](../packages/solana-watcher/src/pegoutScanner.ts)), so a crash in
that gap is self-healing instead of needing a human. Stale-`SEEN` recovery checks the
checkpoint via `SolanaChain.signatureLanded` (new) and a pure
[`classifySeenRecovery`](../packages/solana-watcher/src/pegoutGuard.ts): landed ⇒
`QUEUED`; never landed ⇒ release the claim and retry; no checkpoint (crashed at/before
burn) ⇒ alert. Residual window (burn-return → checkpoint write) is one DB write.

**#4 — SEEN-stale alert dedup (🟡) ✅.** The "stuck in SEEN" alert is tracked in an
in-memory set so a single wedged row alerts once, not every ~5s loop; the id is cleared
when the row recovers (so a recurrence re-alerts), and a restart re-alerts once.

**#5 — stale release/refund alert (🟡) ✅.** The dispatcher now alerts (deduped) when a
row is wedged past `DISPATCHER_STALE_ALERT_MS` (default 1h): `REFUNDING` parents via
`stale()` (quiescent → aged by `updated_at`), and long-`QUEUED` releases/refunds via
`createdAt` off the delivery list (a retrying row bumps `updated_at` every 10s, so it
can't be aged by update time). Surfaces a degraded federation that can't sign.

**#2 — idempotent delivery (🔴 double-mint/release) ✅.** All three chains now close the
BROADCAST-window double-mint/release gap via `Broadcaster.actionExecuted` + persist-before-send:
VIZ (release-by-memo), Solana (mint memo carrying `action.id`), and TON — the last chain —
via deterministic multisig order addresses (`orderExists`/`nextOrderAddress`), see
[`plan-idempotent-delivery.md`](./plan-idempotent-delivery.md) and the TON follow-up
[`plan-ton-peg-in-idempotency.md`](./plan-ton-peg-in-idempotency.md). TON proven live on
testnet 2026-07-02 (`npm run e2e:ton:crash`): a SIGKILL after `new_order` lands recovers to
`CONFIRMED` with `nextOrderSeqno` unchanged (no second order) and the recipient credited once.

**F2 — signer independent source-event validation (🔴 theft vector) ✅.** The signer no
longer trusts the coordinator-supplied `CanonicalAction`: before signing it re-reads the
source event from its OWN node, reconstructs the canonical action, and asserts a
byte-identical digest ([`sourceValidator.ts`](../packages/signer/src/sourceValidator.ts),
gated first in every `KeyedSigner` sign method). Point-lookup primitives added:
`VizChain.getDeposit(trxId, opIndex)` (peg-in; `get_transaction` verified live on
node.viz.cx) and `SolanaChain.getBurn(sig)` (peg-out). For Solana peg-out — which has no
memo — the release target is re-bound by re-deriving the per-account deposit address, so a
poisoned registry row can't redirect funds. To keep the highest-blast-radius secret
single-holder, derivation moved to **additive ed25519**: signers verify with a PUBLIC
`DEPOSIT_MASTER_PUB` (`childPub = masterPub + tweak·G`) while only the sweeper holds the
seed/scalar (`childScalar = masterScalar + tweak`); the sweeper's burn signs with the
explicit scalar (RFC 8032), since the child key is a scalar, not a stock `Keypair` seed.
Offline-verified in [`signer-f2-spike.cjs`](../tools/signer-f2-spike.cjs) (forged peg-in
recipient/amount + peg-out recipient/binding rejected; additive pub/scalar addresses match
and the scalar signature verifies). **TON peg-out source re-validation is deferred** (TON
peg-out not yet active; `sourceId` is a message hash with no clean toncenter-v2 fetch) — the
validator warns and proceeds for that one path only.

## PR #11 (F2) review follow-ups

The F2 review flagged one critical bug (fixed *as* PR #11) plus five deferred items.
Follow-up **①** (TON peg-in on-chain idempotency) was closed by PR #12
([`plan-ton-peg-in-idempotency.md`](./plan-ton-peg-in-idempotency.md)). The remaining
three hardening items are now closed here; **④** (external crypto audit) is the only
open one and is not a code change.

**② — recovery fee recompute returned 0 → FEE_SWEEP skipped (🟠 accounting drift) ✅.**
When an already-executed PEG_IN took the orchestrator recovery path and the fee rebuild
threw (or the coordinator response was lost), the fee reported to the dispatcher was `0`,
so no `FEE_SWEEP` was spawned and the withheld fee stayed a permanent surplus (safe
direction — over-backing — but the ledger drifts). Fixed by making the fee **durable
before broadcast**: the coordinator pins it onto the row via the new `store.setFee`
(an `Orchestrator` `persistFee` hook, called right after `buildProposal`), independent of
the response reaching the dispatcher. `planTransition` no longer clobbers a pinned fee
with `0`, and the dispatcher falls back to the pinned `rec.feeMilliViz` when the response
omits it. Regression: `idempotent-delivery-spike.cjs` case 25 + `outbox-spike.cjs` `setFee`.

**③ — SQLite `SUM(CAST(... AS INTEGER))` overflow (🟡 latent crash) ✅.** A running
total past 2⁶³ makes SQLite fall back to a lossy REAL, and `BigInt("…e+18")` throws.
`unsweptFeesMilliViz`/`capSumMilliViz` now fetch the rows and sum in JS with `BigInt`
(no int64 ceiling — milli-VIZ is unbounded 2⁶⁴⁺). Regression: `outbox-spike.cjs` §6
(two values summing past 2⁶³ add exactly).

**④ — signer Solana account pinning (🟡 hardening) ✅.** `KeyedSigner.approveSolanaMint`
now verifies `proposal.mint`/`multisig`/`nonceAccount` against the operator's OWN config
(`SolanaPins`, wired from `cfg.solana` in `index.ts`), so a compromised coordinator can't
point a mint at attacker-controlled accounts — the F2 "trust your own config" principle
applied to the Solana write path. Skipped only when Solana is unconfigured (spikes).
Regression: `solana-orchestration-spike.cjs` (tampered mint/multisig/nonceAccount rejected,
honest config accepted).

**⑤ — self-written ed25519 in `depositAddress.ts` → external crypto audit (🟡) — OPEN.**
The additive-derivation code (`childPub = masterPub + tweak·G`, explicit-scalar signing)
is hand-rolled crypto; it is offline-verified (`signer-f2-spike.cjs`) but a candidate for
an external review, not a code fix.

## Remaining / follow-ups

- Live on-chain mint targets: TON multisig-v2 `new_order`+`approve`; Solana mint +
  burn validated on devnet.
- Lookup: real VIZ-account existence check ✅ (issuance gated on `VizChain.accountExists`).
  Same deposit-address model can extend to TON later (TON has a comment field, so it's
  lower priority).
- E4/E5: the scanner now **claims first** (writes a `SEEN` outbox row keyed on the tx
  signature) before burning, and releases the claim (`store.delete`) if the burn fails,
  so a duplicate scan can't double-burn and a crash-after-burn leaves a visible `SEEN`
  row (alerted via `notifyStaff`) instead of a silently-lost release. Still not fully
  atomic: completing a stranded `SEEN` peg-out needs an on-chain burn check (the
  `BURNED`-checkpoint follow-up) before flipping it to `QUEUED`.
- Fee constants are in shared config; embedding them in the committed federation
  manifest would harden cross-operator determinism.
