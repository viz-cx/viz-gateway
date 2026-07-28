# `source-hints.json` — operator resolution directives (coordinator-only)

Read **only** by the coordinator (`packages/coordinator/src/sourceHints.ts`) at boot and on every
`/submit`. It resolves peg-ins whose F2 re-read fails because the deposit's VIZ block was pruned
from `operation_history` (see `docs/plan-refund-pruned-history-getblock.md` and
`docs/runbook-mainnet-bringup.md §2a–§2c`). Signers never read this file — they only receive the
(untrusted) block number.

## Shape

```json
{
  "<trxIdHex>:<opIndex>": {
    "sourceBlockNum": 81976371,
    "resolution": "mint"
  }
}
```

- **Key** = the parent PEG_IN action id, `"<trxIdHex>:<opIndex>"`. Lowercase; a pasted UPPERCASE
  explorer trx id is normalized automatically.
- **`sourceBlockNum`** (optional) — the VIZ block the deposit landed in. Used as the `getDeposit`
  block-log fallback hint **only when the DB row's `block_num` is NULL** (rows predating that
  column); the DB value wins when present. UNTRUSTED: every signer re-reads the block from its own
  node and recomputes the trx id, so a wrong number just fails closed — it can never redirect funds.
- **`resolution`** (optional) — `"mint"` redirects a stuck refund to COMPLETE the peg-in; omit or
  `"refund"` for the default (no redirect). Selects mint-vs-refund ONLY; the recipient is
  memo-derived and re-validated by every signer.

## Applying a `"mint"` redirect

It mutates outbox state, so it runs **once, at coordinator boot, and only while the gateway is
paused**. Pause → deploy/restart → unpause. Full procedure in `runbook-mainnet-bringup.md §2c`.
Fail-closed: a malformed file or entry is dropped with a warning (never trusted).

## Housekeeping

Entries are safe to leave in place (idempotent — a `gateway_state` marker makes re-runs no-ops), but
prune resolved incidents to keep the file readable. Future deposits self-heal automatically
(`block_num` is persisted at enqueue), so new entries should be rare.
