# Runbook: TON Gas Replenishment + Rate-Limited Deposit Handling

## Background: the currency mismatch

Every GRAM peg-in mint burns ~0.06 TON in on-chain gas (multisig `new_order` + `approve` × N operators). Fees, however, are collected in **VIZ** at `fees.gate`. This creates a mismatch: gas depletes in TON while revenue accumulates in VIZ.

The gateway monitors the GRAM multisig TON balance via `GRAM_SUBMITTER_MIN_NANO` (default 2 TON = 2,000,000,000 nano-TON). When it falls below the floor, recon pauses GRAM peg-ins and pages operators.

---

## 1. Monitoring

Check `/health` on the coordinator for `paused: true` + a `pauseReason` containing `GRAM TON reserve low`. The recon loop also calls the GRAM `tonBalanceNano` check every `RECON_INTERVAL_MS` (default 30 s).

Grafana / alerting: if `STAFF_WEBHOOK_URL` is set, a `reserve` scope notification fires with `balanceNano` and `floorNano`.

Runway estimate: balance / (approvals_per_mint × 0.06 TON × 24 × 3600 / avg_mint_interval_s).

Target buffer: ≥ 5 TON (≈ 80 mints of runway at the current 0.06 TON/mint gas cost).

---

## 2. Replenishment procedure

1. **Check the pause:** confirm `GET /health` → `paused: true` and reason mentions TON reserve.

2. **Convert accumulated fees to TON (off-platform):**
   - `fees.gate` accumulates VIZ. Withdraw a portion using the standard VIZ release path (peg-out or direct transfer from the ops key).
   - Swap VIZ → TON via any exchange or OTC desk. Target ≥ 5 TON per top-up.

3. **Top up the multisig / operator wallets:**
   - The **multisig** itself (`GRAM_MULTISIG_ADDRESS`) pays the `new_order` gas.
   - Each **operator wallet** (the wallet tied to `GRAM_SIGNER_MNEMONIC`) pays the `approve` gas.
   - Typical amounts: 3–5 TON to the multisig; 1–2 TON to each operator wallet.
   - Use any standard TON wallet to send from your converted TON to these addresses.

4. **Verify the balance is above the floor:**
   ```bash
   # Quick check via toncenter REST (replace ADDRESS and APIKEY):
   curl "https://toncenter.com/api/v2/getAddressInformation?address=ADDRESS" \
     -H "X-API-Key: APIKEY" | jq '.result.balance'
   ```
   Balance must be > `GRAM_SUBMITTER_MIN_NANO` (default 2,000,000,000 nano-TON).

5. **Unpause the gateway:**
   The pause is cooperative — any operator can call `POST /unpause` on the coordinator (or use the manual-unpause script). Recon will resume automatically and will not re-pause unless the balance dips again.

---

## 3. Handling HELD(RATE_LIMITED) deposits

Deposits from senders who exceed `PEG_IN_RATE_MAX_PER_WINDOW` (default 10) in a `PEG_IN_RATE_WINDOW_MS` rolling window (default 1 hour) are durably held as `HELD("RATE_LIMITED")`.

Unlike `HELD("INVALID_DESTINATION")`, these are **not auto-refunded**. An operator must decide:

### Option A: Release (mint the held deposit)
Flip the row from HELD → QUEUED. The dispatcher will pick it up on the next tick.

```bash
# Using the gateway's admin CLI (if available), or direct SQLite:
sqlite3 ./data/gateway.sqlite \
  "UPDATE action_outbox SET status='QUEUED', next_attempt_at=0 WHERE id='<ACTION_ID>' AND status='HELD'"
```

Use this if the deposit appears legitimate (e.g. a power user, exchange integration, or a previously stuck batch).

### Option B: Refund (return the deposit)
Flip the row from HELD → REFUNDING. The dispatcher will spawn a `:refund` child.

```bash
sqlite3 ./data/gateway.sqlite \
  "UPDATE action_outbox SET status='REFUNDING', next_attempt_at=0 WHERE id='<ACTION_ID>' AND status='HELD'"
```

### Batch release of all rate-limited rows from a trusted sender
```bash
sqlite3 ./data/gateway.sqlite \
  "UPDATE action_outbox SET status='QUEUED', next_attempt_at=0
   WHERE status='HELD' AND last_error='RATE_LIMITED' AND sender='<VIZ_ACCOUNT>'"
```

---

## 4. Re-quoting GRAM_VIZ_PER_TON

Each operator sets their own `GRAM_VIZ_PER_TON` (VIZ per 1 TON). The coordinator takes the **median** of all live signer quotes to derive the dynamic fee floor.

The floor is bounded by `FEE_MIN_VIZ_PER_TON`..`FEE_MAX_VIZ_PER_TON` (default 100–20,000), so extreme quotes are clamped. A fee floor derived from an accurate quote covers gas + margin without overcharging users.

**When to update:**
- TON price moves > 20% from the current quote (floor drifts outside comfortable gas coverage).
- Margin erosion: floor approaching 0.06 TON × quote × 1.5 approaches mintGasFloor.
- After a federation upgrade that changes gas constants in `federation.json`.

**Procedure:** update `GRAM_VIZ_PER_TON` in the signer's `.env.mainnet` and restart the signer daemon. The new quote is included in the next registration heartbeat (every `REGISTRATION_LEASE_MS`, default 5 min). No coordinator restart required.
