# Plan — R-1 Medium findings (VG-02, VG-03, VG-04, VG-06)

Remediation plan for the four remaining open Medium findings from
`docs/audit/R1-EXTERNAL-AUDIT-REPORT.md`. VG-01 (High) and VG-05 (Medium) are
already fixed and merged / in-branch.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

- ☑ **VG-05** — canonical encoding injectivity (merged PR #25, main `5387d6b`).
- ☑ **VG-02** — recon fails open: `Promise.allSettled` per-remote + consecutive-failure escalation
  + zero-remotes fatal; `packages/recon/src/checker.ts` (`Recon` class); `tools/recon-failclosed-spike.cjs`.
- ☑ **VG-03** — VIZ peg-in detection gap: durable cursor (`getCursor`/`setCursor`)
  + cap-bounded advance via `nextScanWindow`; `tools/viz-scan-cursor-spike.cjs`.
- ☑ **VG-06** — TON burn scan lt-paginated (`paginateBurnsByLt`) + fail-closed on
  truncation (pause + `notifyStaff`); `tools/ton-scan-pagination-spike.cjs`.
- ☐ VG-04 — fee amount coordinator-authoritative for the sweep

VG-03 + VG-06 (+ the shared cursor primitive) shipped together on
`fix/vg-watcher-cursors`. Both spikes wired into `npm run verify` (full suite green).

Common theme for VG-02/03/06: **fail-closed detectors**. A custody bridge's
detectors must never silently advance past unseen work or report "healthy" when
they cannot actually see the chain. Where a transient blip shouldn't instantly
halt the whole gateway, escalate on a *consecutive-failure / staleness threshold*
rather than either failing open or paging on the first hiccup.

---

## Shared prerequisite — durable cursor primitive (store)

VG-03 and VG-06 both need a **persisted scan cursor** (survives restart). The
store already has a `gateway_state` KV table with private `getKey`/`setKey`
(currently backing the pause flag). Promote a typed cursor API onto the
`GatewayStore` interface:

- `getCursor(name: string): Promise<number>` — returns 0 if unset.
- `setCursor(name: string, value: number): Promise<void>` — monotonic; ignore a
  write that would move the cursor backward (guards against a racing/stale writer).

Implement on both `SqliteGatewayStore` (via existing `gateway_state` KV, value
stored as text) and `InMemoryGatewayStore` (a `Map<string, number>`). Cursor
names: `"cursor:viz-watcher"`, `"cursor:ton-watcher"`.

File: `packages/common/src/store.ts` (interface at ~line 24; sqlite impl ~106;
in-memory impl ~365). Rebuild `@gateway/common` before dependent packages.

---

## VG-02 — recon fails open on node error / missing remotes

**File:** `packages/recon/src/index.ts`

Three fail-open holes:
1. `check()` wraps `viz.gatewayBalance`, `Promise.all(remotes.map(supply))`, and
   `unsweptFees` in one `Promise.all`. Any RPC throw rejects the whole check; the
   loop `catch` (index.ts:116-118) only logs → recon silently stops verifying
   backing during a node outage. One remote's RPC failure also blinds recon to
   the *other* remote.
2. Zero remotes (index.ts:40-42) → `circulating = 0` → drift = locked ≥ 0 →
   always "OK". A misconfigured recon reports healthy while wVIZ may circulate.
3. `reserveCheck` already fails soft (correct — it pages, doesn't pause).

**Changes:**
- **Zero remotes = fatal.** If `remotes.length === 0`, `throw` at startup (like
  ton-watcher does for a missing minter). A recon that can see no wVIZ supply
  must not run. Keep the multi-remote intent: this is a misconfig, not a state.
- **Per-remote failure is indeterminate, not zero.** Replace
  `Promise.all(remotes.map(supply))` with `Promise.allSettled`; if *any* remote
  supply is unavailable, treat circulating as **unknown** → do NOT compute a
  falsely-healthy drift. Count it as a failed check (see next point). Never let a
  missing supply reduce `circulating`.
- **Consecutive-failure escalation.** Track `consecutiveFailures`. A check that
  cannot obtain locked + *all* supplies + unsweptFees increments it; a clean
  check resets it. When it reaches `cfg.recon.maxConsecutiveFailures` (new
  config, default e.g. 3), `store.pause("recon cannot verify backing (N
  consecutive failures)")` + `notifyStaff`. Rationale: sustained inability to
  prove the peg invariant is itself a critical condition — fail closed.
- **`RECON_ONCE` path:** a failed check must exit non-zero (already does via the
  outer `.catch`, but make the once-mode branch explicit: exit code 2 on
  indeterminate, matching the existing UNDER-BACKED convention).

**Config:** add `recon.maxConsecutiveFailures` to `packages/common/src/config.ts`
(env `RECON_MAX_CONSECUTIVE_FAILURES`, default 3).

**Spike:** `tools/recon-failclosed-spike.cjs` — pure, using `InMemoryGatewayStore`
and fake remotes:
- zero remotes → constructor/startup throws.
- one remote throws → check is indeterminate, circulating not reduced, no false
  OK; after `max` consecutive failures → `store.isPaused()` true.
- healthy check resets the failure counter (no pause after a blip + recovery).
- genuine under-backing still pauses (regression guard).
Wire into `npm run verify`.

---

## VG-03 — VIZ peg-in detection can silently skip deposits

**Files:** `packages/viz-watcher/src/index.ts`, `packages/viz-watcher/src/vizChain.ts`

Two compounding gaps:
1. **In-memory cursor** (`let cursor = 0`, index.ts:27) → on restart, cursor
   resets and cold-starts at the current safe head (index.ts:48-50), skipping
   every deposit that landed during downtime.
2. **Unconditional `cursor = safeHead`** (index.ts:83) while
   `irreversibleDepositsSince` caps the scan at `start + MAX_BLOCKS_PER_SCAN - 1`
   (vizChain.ts:73, cap 200). If the backlog exceeds 200 blocks (post-downtime or
   a burst), blocks beyond the cap are never scanned — permanent silent gap.

**Changes:**
- **Persist the cursor.** On start, `cursor = await store.getCursor("cursor:viz-watcher")`.
  Cold start (0) still initializes to safe head *and persists it* so the "start
  here" decision is made once. After each successful scan, `setCursor`.
  ⚠️ Cold-start-at-head still means deposits before first-ever run aren't
  backfilled — that's the documented "historical backfill is a separate
  operation" (index.ts:26). Keep that; VG-03 is about *downtime after* first run.
- **Advance cursor only to what was actually scanned.** Change
  `irreversibleDepositsSince` to return `{ deposits, scannedTo }` (or export
  `MAX_BLOCKS_PER_SCAN` and have the watcher compute the capped end). Set
  `cursor = scannedTo` (persisted), NOT `safeHead`. When `scannedTo < safeHead`
  (backlog), loop again immediately (skip the 3s sleep) to catch up fast.
- Same fix pattern will be reused conceptually by VG-06.

**Spike:** `tools/viz-scan-cursor-spike.cjs` — pure, with a fake `VizChain`:
- backlog > MAX_BLOCKS_PER_SCAN → cursor advances by the cap, not to head; a
  second tick scans the remainder; no block is skipped.
- restart with a persisted cursor resumes from it (not from head).
- `scannedTo` never exceeds the real scanned end.
Wire into `npm run verify`.

---

## VG-06 — TON burn scan not height-ranged; bursts silently truncated

**Files:** `packages/ton-watcher/src/tonChain.ts`, `packages/ton-watcher/src/index.ts`

`finalizedBurnsSince(_fromHeight, toHeight)` ignores `_fromHeight` and fetches the
last `maxTransactions` (default 20) txs; `index.ts:80` advances the cursor
regardless. More than `maxTransactions` burns between scans → older burns fall out
of the window, never processed, cursor advances anyway → user's wVIZ is burned but
never released. No alert. (The report notes §8 "limit-windowed scan" *under-rates*
this.)

**Changes (real protocol work — TON pagination by logical time):**
- **Track last-processed `lt` (logical time), not masterchain height.** TON wallet
  txs are ordered by `lt`; that's the correct cursor for the gateway wallet's own
  tx stream. Persist `store.getCursor("cursor:ton-watcher")` as the last-processed
  `lt` (fits a JS number for TON `lt` ranges; if precision is a concern, store as
  text and compare as BigInt — prefer BigInt-safe compare).
- **Paginate `getTransactions` until reaching the cursor.** `TonClient.getTransactions`
  supports `{ limit, lt, hash, to_lt }`. Scan newest → older in pages of
  `maxTransactions`, collecting burns, stopping once a tx's `lt <= lastProcessedLt`
  (or the wallet's history end). This makes the scan genuinely range-based instead
  of a fixed tail.
- **Truncation guard / fail-closed backstop.** If pagination hits a sane
  page-count ceiling (`cfg.ton.maxScanPages`, new, default e.g. 50) before
  reaching the cursor, do NOT advance the cursor past the last fully-scanned tx,
  and `notifyStaff` (and optionally `store.pause`) — a burst we can't fully drain
  must not be silently skipped.
- Advance the cursor to the newest processed `lt` only after a complete drain.

**Verify the TON client pagination API** against the installed `@ton/ton` version
before coding (use context7 / the installed d.ts). The existing spikes
(`tools/ton-*-spike.cjs`) and `contracts/ton/tools/verify-offline.cjs` show the
offline test idiom.

**Spike:** `tools/ton-scan-pagination-spike.cjs` — pure, with a fake tx source:
- > maxTransactions burns since cursor → all are collected across pages; none
  dropped; cursor ends at newest `lt`.
- page ceiling reached → cursor holds, alert fired, no silent skip.
- lt cursor persists across restart.
Wire into `npm run verify`.

---

## VG-04 — fee is coordinator-authoritative for the sweep (validated by range)

**Files:** `packages/coordinator/src/orchestrator.ts`,
`packages/dispatcher/src/policy.ts`, `packages/signer/src/sourceValidator.ts`

The minted `net` is F2-validated exactly, but the `FEE_SWEEP` amount is taken from
`ctx.feeMilliViz` (coordinator-supplied) and the signer only checks it lies within
`[base, base + activationSurcharge]` (sourceValidator.ts:191-209) — a *range*, not
an *exact* independently-derived value. A coordinator could steer the fee within
that band.

**Change:** make the signer **re-derive the exact fee** from the source deposit it
already independently re-reads (F2 already fetches the `VizDeposit`). The fee is a
pure function of gross + the activation flag (`quotePegIn`/`baseFee` in
`packages/common/src/fees.ts`), so the signer can compute the exact expected fee
and require `sweepAmount === expectedFee` (exact), removing the range acceptance.
The one genuine variable is the activation surcharge (destination provisioned or
not) — the signer must derive `provisioned` from its own chain read
(`accountExists` / the PDA/ATA existence check already used elsewhere), NOT from a
coordinator flag. If provisioning state is ambiguous at signing time, fail closed.

**Care:** this touches the trust boundary and the fee/net conservation invariant
(`net + fee == gross`). Confirm the signer's exact fee matches what the coordinator
used for `net` so a legitimate sweep still validates. Do this finding LAST, on its
own branch/PR, with a dedicated spike extending `tools/fee-sweep-refund-spike.cjs`
or a new `tools/fee-exact-signer-spike.cjs`:
- signer re-derives exact fee from its own gross read; range no longer accepted.
- coordinator fee ≠ exact derived → signer rejects the sweep.
- activation surcharge decided by signer's own existence check, not a flag.
- `net + fee == gross` still holds end-to-end.

---

## Suggested PR sequencing

1. **VG-05** (this branch) — small, self-contained. Merge first.
2. **Cursor primitive + VG-03 + VG-06** — share the `getCursor/setCursor` store
   addition; both are watcher scan-range fixes. One PR (or split VG-06 out if the
   TON pagination grows large).
3. **VG-02** — recon fail-closed. Independent, small-ish. Own PR.
4. **VG-04** — trust-boundary fee re-derivation. Own PR, last.

After all four merge + `npm run verify` green: update `docs/audit/` remediation
status for VG-02/03/04/06, then the R-1 external audit becomes the only remaining
pre-mainnet gate.

## Global conventions to follow

- Tests are `tools/*-spike.cjs` (pure, `node:assert`, run offline against
  `dist/`), wired into the `verify` npm script. No `*.test.ts` in this repo.
- Build order: `npm run build` (tsc project refs) before running spikes.
- Fail-closed default: when a detector can't confirm chain state, halt/alert —
  never advance or report healthy.
- Match existing file idiom (comment density, `[component]` log prefixes).
