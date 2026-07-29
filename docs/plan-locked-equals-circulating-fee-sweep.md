# Plan — make `VIZ locked` == `wVIZ circulating` (one-time revenue reconciliation)

**Status:** DRAFT for review — dry-run prep in progress. Session 2026-07-28.
**Goal (user):** move retained gateway *revenue* out of the per-chain backing account
(`gram.gate`) to `fees.gate` so the public site shows `VIZ locked == wVIZ circulating` (gap 0).
**Chosen approach:** SIMPLE one-time operator reconciliation (NOT the automated/trustless per-peg-in
sweep — that would need new per-chain remote-mint readers in the signer + an all-signer redeploy,
a large attack-surface expansion for ~47.5 VIZ; rejected). Effectively permanent given glacial
traffic; the automated version can be built later if volume ever justifies it.

---

## 1. Verified accounting (read from code this session)

- `locked` (recon) = **`gram.gate` on-chain balance only** — the per-chain *backing* account.
  `fees.gate` is separate and NOT part of `locked` (`recon/index.ts:68`). ⇒ a sweep to `fees.gate`
  genuinely reduces `locked`.
- `unsweptFeesMilliViz` = `sum(PEG_IN.fee WHERE status∈{BROADCAST,CONFIRMED}) −
  sum(FEE_SWEEP.amount WHERE CONFIRMED)` (`store.ts:399`). ⇒ **inserting a CONFIRMED `FEE_SWEEP`
  row lowers `unsweptFees` by its amount** — this is the lever that keeps recon in lockstep.
- Recon: `expectedLocked = circulating + unsweptFees`; `drift = locked − expectedLocked`;
  **PAUSE iff `drift < −driftTolerance`** (tolerance 0) (`checker.ts:136`).
- Over-sweep guard: `unsweptFees < 0 ⇒ PAUSE` (`checker.ts:127`). ⇒ the reconcile row amount must be
  **≤ current `unsweptFees`**, and to zero the gap exactly it must **equal** it.
- A REFUNDED peg-in is not in `MINTED_STATUSES` ⇒ its withheld refund fee is **pure positive drift**
  surplus, invisible to recon. Removing it only shrinks positive drift → no pause, no reconcile row.

### Live numbers — PINNED from the authoritative recon reading (2026-07-28, stable ≥4 ticks)
`[recon] locked=43492408 circulating=43444908 unsweptFees=37500 drift=10000 status=OK` (all mVIZ)
- `gram.gate` (locked) = 43,492,408 mVIZ — matches on-chain (node.viz.cx + api.viz.world). ✓
- `circulating` = 43,444,908 mVIZ; `unsweptFees` = 37,500 mVIZ; `drift` = 10,000 mVIZ.

### Derived reconciliation quantities (EXACT — do not round)
- **T (transfer) = locked − circulating = 47,500 mVIZ = 47.500 VIZ** (= drift 10,000 + unswept 37,500 ✓)
- **R (reconcile FEE_SWEEP row) = unsweptFees = 37,500 mVIZ = 37.500 VIZ**
  (the extra 10,000 of T is pure drift surplus — needs NO row; removing it moves drift 10,000 → 0.)

---

## 2. The reconciliation (two derived quantities)

From ONE authoritative recon reading (`locked`, `circulating`, `unsweptFees`, `drift`):

- **T (transfer amount)** = `locked − circulating` = `drift + unsweptFees`.
  A single VIZ transfer `gram.gate → fees.gate` of `T` (expected ≈ 47.5 VIZ).
- **R (reconcile row amount)** = `unsweptFees` (expected 37.5 VIZ).
  One `FEE_SWEEP`/CONFIRMED/GRAM row of `R` inserted into the store.

**Post-state check (algebra):**
`locked' = locked − T = circulating`; `unsweptFees' = unsweptFees − R = 0`;
`drift' = locked' − (circulating + 0) = 0`. ✅ gap 0, no false-pause, over-backed at every step.

**Ordering (fail-safe):** the transfer LOWERS `locked` (→ drift negative) while the reconcile row
LOWERS `unsweptFees` (→ drift back toward 0). If done in the wrong order there's a transient window:
- Insert reconcile row FIRST → `unsweptFees` drops to 0, `locked` unchanged ⇒ `drift = +T` (still
  positive, no pause) — SAFE transient.
- Transfer FIRST → `locked` drops T, `unsweptFees` still 37.5 ⇒ `drift = −37.5` ⇒ **PAUSE**.
⇒ **Insert the reconcile row BEFORE broadcasting the transfer.** (Recon re-pauses within ~30s if
wrong, so the row-first ordering makes the intermediate state provably safe.)

---

## 3. Execution steps

### ✅ DONE this session (dry-run prep, nothing broadcast/written)
- **[0] Authoritative read** — pinned above (recon line, stable). `locked` cross-checks on-chain. ✓
- **[1] Transfer proposal built (DRY-RUN)** → `reconcile-proposal.json`:
  ```
  FROM=gram.gate TO=fees.gate AMOUNT_VIZ=47.5 \
    MEMO="reconcile: sweep retained revenue to fees.gate" \
    PROPOSAL_OUT=reconcile-proposal.json node tools/manual-refund.cjs build
  ```
  Result: `gram.gate → fees.gate 47.500 VIZ`, authority threshold 2, txid `b107df1e…`.
  ⚠️ Its 45-min expiration is stale at execution time — **rebuild fresh** (same command) right
  before signing so the TaPoS + expiration are current.

### ⏸ REMAINING (execution — each needs a separate explicit go-ahead)
- **[2] Insert the reconcile row FIRST** (fail-safe ordering — §2). On the coordinator, node:sqlite
  `DatabaseSync` at `/app/data/gateway.sqlite` inside the `viz-gateway-coordinator-web` container:
  ```js
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync('/app/data/gateway.sqlite');
  const now = Date.now();
  db.prepare(`INSERT INTO action_outbox
    (id,direction,remote_chain,recipient,amount_milli_viz,fee_milli_viz,digest,status,attempts,created_at,updated_at,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run('reconcile:activation-surplus-2026-07-28:fee','FEE_SWEEP','GRAM','fees.gate',
        '37500','0','reconcile:activation-surplus-2026-07-28','CONFIRMED',0,now,now,0);
  ```
  (id is PRIMARY KEY → re-run is a safe no-op/error, never a double-insert. CONFIRMED ⇒ inert to the
  dispatcher, which only scans QUEUED/BROADCAST.) Then **verify** recon logs `unsweptFees=0`,
  `drift=47500`, `status=OK` (positive drift = over-backed = safe transient).
- **[3] Rebuild proposal fresh** (step [1] command) for current TaPoS.
- **[4] Two operators co-sign** on their own boxes: `VIZ_SIGNING_WIF=<active WIF>
  node tools/manual-refund.cjs sign reconcile-proposal.json` (op-2 = this box + op-3).
- **[5] Broadcast** (`APPLY=1 node tools/manual-refund.cjs broadcast reconcile-proposal.json <sigA>
  <sigB>`). DRY-RUN first (no APPLY) to review the final signed tx.
- **[6] Verify:** on-chain `gram.gate` = 43,444.908, `fees.gate` = 366.500; recon `drift=0
  status=OK`; `/health` `paused:false` stable; site gap 0.

---

## 4. Notes / caveats
- `manual-refund.cjs` is the purpose-built general 2-of-3 VIZ transfer OUT of a backing account
  (`FROM/TO/AMOUNT_VIZ/MEMO`, DRY-RUN unless `APPLY=1`, production `signRelease` lib, does NOT touch
  store/coordinator). Bypassing the automated F2 path is correct here: operators deliberately move
  their OWN revenue between their OWN 2-of-3 accounts.
- Run when quiescent (glacial traffic) so no new peg-in shifts `gram.gate` between read and transfer.
- Requires op-2 (this box) + op-3 (independent operator) to co-sign; op-1 offline. 2-of-3 met.
- Over-transfer by even a hair → `drift < 0` → pause; hence pin `T` from the authoritative read and
  transfer an EXACT amount (not "drain to X").
- One-time (not automated). Going forward, new activation surcharges slowly re-accrue as safe
  over-backing `unsweptFees`; reconcile again if it ever matters. Refund fees likewise.
