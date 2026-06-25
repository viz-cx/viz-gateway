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
  `X = HMAC-SHA512(MASTER_SEED, vizAccount)[:32] → Keypair.fromSeed` (node:crypto only,
  no extra deps). The `MASTER_SEED` is a single hot key **outside the multisig** (like
  `fees.gate`): it can only burn the transient wVIZ on these addresses, never mint or
  touch the VIZ backing. Spike: `tools/pegout-address-spike.cjs`.
- **E2 — lookup service.** [`lookup.ts`](../packages/solana-watcher/src/lookup.ts):
  `GET /address?viz_account=alice → { address, ata, mint, warning }`. Stateless
  derivation; open/unauthenticated (release is bound to derivation → a third party can
  only gift, never redirect). Warns to send only wVIZ on Solana. _TODO:_ validate the
  VIZ account exists on-chain before issuing (currently a format check).
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

## Remaining / follow-ups

- Live on-chain mint targets: TON multisig-v2 `new_order`+`approve`; Solana mint +
  burn validated on devnet.
- Lookup: real VIZ-account existence check; same deposit-address model can extend to
  TON later (TON has a comment field, so it's lower priority).
- E4/E5 are not atomic across burn→enqueue; a `BURNED` checkpoint per signature would
  make a mid-crash fully recoverable.
- Fee constants are in shared config; embedding them in the committed federation
  manifest would harden cross-operator determinism.
