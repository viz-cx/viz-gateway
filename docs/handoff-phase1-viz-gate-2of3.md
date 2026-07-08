# Handoff — Upgrade VIZ gate accounts to 2-of-3 (mainnet launch, Phase 1)

**For:** the holder of the `gram.gate` / `fees.gate` bootstrap master keys.
**Goal:** switch each gate account from its temporary **1-of-1 bootstrap key** to the
**2-of-3 operator keyset** (the launch federation), then fund it. TON-only launch —
leave `solana.gate` untouched for now.

> ⚠️ **Order matters: upgrade authority FIRST, fund SECOND.** Never send VIZ to an
> account while it is still 1-of-1 — a single key custodying real balance is exactly
> the risk the federation exists to remove.

---

## What you need before starting

1. **The 3 operator VIZ public keys** (`VIZ7…`), collected from the 3 independent
   operators. These are *public* values — no private WIFs/mnemonics are collected here.
   Fix their order once (op-1, op-2, op-3) and keep it consistent.
2. **The current bootstrap master WIF** for each account you're upgrading:
   - `gram.gate` → `VIZ5fmDqyyk9…`
   - `fees.gate` → `VIZ5N1xLbUCp…`
   (These are the temporary single keys the accounts were created under.)
3. A checkout of this repo with Node installed.

---

## The tool

`npm run setup:viz-account` (source: `setup-viz/src/setupAccount.ts`). It sets the
account's **active** set = the operational 2-of-3, and **master** = the same 2-of-3
(master can rewrite active, so it must also require ≥2 signers — the tool **refuses a
single-signer master**). It reuses the on-chain `memo_key` and `json_metadata`, and
leaves `recovery_account` unchanged. It is **dry-run by default**; broadcasting requires
`APPLY=1` **and** the master WIF.

Env vars it reads:

| var | value |
|---|---|
| `GATEWAY_ACCOUNT` | `gram.gate`, then `fees.gate` |
| `ACTIVE_KEYS` | the 3 operator pubkeys, comma-separated: `VIZ7a,VIZ7b,VIZ7c` |
| `ACTIVE_THRESHOLD` | `2` |
| `MASTER_KEYS` | **same 3 pubkeys** |
| `MASTER_THRESHOLD` | `2` |
| `GATEWAY_MASTER_WIF` | the account's bootstrap master WIF — **only for `APPLY=1`** |
| `APPLY` | omit for dry-run; `1` to broadcast |

---

## Step 1 — Build

```bash
npm run build
```

## Step 2 — Dry-run `gram.gate` (safe, no broadcast)

Replace the three `VIZ7…` placeholders with the real operator pubkeys:

```bash
GATEWAY_ACCOUNT=gram.gate \
ACTIVE_KEYS=VIZ7opA,VIZ7opB,VIZ7opC ACTIVE_THRESHOLD=2 \
MASTER_KEYS=VIZ7opA,VIZ7opB,VIZ7opC MASTER_THRESHOLD=2 \
npm run setup:viz-account
```

Check the printout before going further:
- `active  (2 of 3)` and `master  (2 of 3)` list the 3 operator keys.
- `CURRENT master on chain` still shows the 1-of-1 bootstrap key (confirms nothing
  has changed yet).
- It ends with `DRY-RUN. Set APPLY=1 …`.

## Step 3 — Apply `gram.gate` (broadcasts the authority change)

Same command, with `APPLY=1` and the bootstrap master WIF prepended:

```bash
APPLY=1 GATEWAY_MASTER_WIF=<gram.gate bootstrap master WIF> \
GATEWAY_ACCOUNT=gram.gate \
ACTIVE_KEYS=VIZ7opA,VIZ7opB,VIZ7opC ACTIVE_THRESHOLD=2 \
MASTER_KEYS=VIZ7opA,VIZ7opB,VIZ7opC MASTER_THRESHOLD=2 \
npm run setup:viz-account
```

## Step 4 — Repeat for `fees.gate`

Identical, with `GATEWAY_ACCOUNT=fees.gate` and its own bootstrap WIF
(`VIZ5N1xLbUCp…`). **Do not** touch `solana.gate` — it stays dormant until the
Solana window (Phase 2).

## Step 5 — Verify, then fund

- Re-read each account (e.g. run the dry-run again, or check on a VIZ explorer) and
  confirm the live **active** and **master** authorities are the 2-of-3 operator
  keyset — not the old bootstrap key (anti-rollback check).
- Only now, **fund**:
  - `gram.gate` — a **small** backing balance for the soft-launch (grow later as the
    operator set grows).
  - `fees.gate` — accrues swept fees; a small starting balance is fine.
- **Discard the bootstrap master WIFs** after the upgrade is confirmed — they are no
  longer needed and are single points of failure.

---

## Safety recap

- Authority change **before** funding, always.
- Only public `VIZ7…` keys are shared with the coordinator; operators keep their own
  private WIFs. If any single party ends up holding ≥2 of the operator private keys,
  the 2-of-3 is fake — don't let that happen.
- `MASTER_THRESHOLD` must be `2` (the tool rejects a single-signer master).
- Dry-run every command once before adding `APPLY=1`.
