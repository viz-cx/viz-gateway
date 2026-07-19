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

## 4. Auto-return of wVIZ (unusable peg-out destination)

When a user burns wVIZ on TON with a peg-out memo naming an unusable VIZ account—one that is empty, malformed, or non-existent—the gateway automatically returns the held wVIZ to the original TON sender (minus the refund fee).

### Trigger & behavior

- **Empty account:** memo name exists but the VIZ account has zero balance and no active voting.
- **Malformed account:** memo name does not parse as a valid VIZ account (wrong format, invalid characters).
- **Non-existent account:** memo name parses as valid but the account does not exist on VIZ.

In any of these cases, the watcher detects that the burn **cannot** mint a corresponding VIZ release, so it flags the action as `REFUNDING` with a `:return` child order. The child is a jetton-transfer (op `0x0f8a7ea5`) returning the held wVIZ to the sender's original TON wallet, minus `refundFeeMilliViz` (currently 5 VIZ) to cover the return transfer gas.

### Fee & dust rule

- **Refund fee:** currently 5 VIZ (configurable via `REFUND_FEE_MILLI_VIZ`).
- **Dust rule:** if the gross burned amount is ≤ refund fee, the deposit is retained as gateway surplus and no return is initiated. This avoids unnecessary on-chain operations for negligible amounts.

Example: a user burns 3 wVIZ with an unusable destination → 3 ≤ 5, so the 3 wVIZ is kept by the gateway as a fee. A user burns 10 wVIZ → return initiates with (10 − 5) = 5 wVIZ sent back; 5 wVIZ is the fee.

### Supply neutrality & TON-only scope

- **No native VIZ released.** A `:return` child does not unlock any gateway-held VIZ; it only re-circulates the wVIZ that was already burned.
- **No wVIZ minted or burned.** The burned wVIZ is already off-chain; the `:return` order simply transfers held wVIZ back to the sender.
- **TON/GRAM only.** This feature applies only to GRAM (TON) peg-outs. Solana peg-outs to unusable destinations are not currently supported.

### Liveness requirement

A `:return` order requires the same conditions as a peg-in mint:

- **≥ 2 operators online + funded** on TON (each operator wallet must have enough TON to pay the `approve` gas).
- If the gateway multisig is below `GRAM_SUBMITTER_MIN_NANO`, the return order will queue but may not broadcast until TON is replenished (see § 1 & 2).

### Order window & manual recovery

If the `:return` order window lapses (default 60 seconds from proposal) before ≥ 2 approvals are collected, the action row remains in `REFUNDING` status and **a staff alert is triggered** via `STAFF_WEBHOOK_URL`. The order does **not** auto-retry; instead, an operator must manually return the wVIZ using the standard tooling.

**Manual return procedure** (if auto-return times out):

```bash
# Use the existing manual-refund tooling:
# node tools/manual-refund.cjs <action_id> <recipient_ton_address> <amount_milli_viz>
node tools/manual-refund.cjs \
  "action:7c9e..." \
  "UQCu_5...7_UX9" \
  5000  # 5 wVIZ = 5000 milliVIZ
```

Coordinate with ≥ 2 other signers to collect enough TON approvals, then broadcast the multisig jetton-transfer order.

### Race resolution: strict refuse-when-usable

The signer includes a full re-check of the VIZ destination at approval time via `validateGramReturn`. If the signer's own VizChain sees the destination account **exists** at that moment (account was created between watcher scan and approval), the signer **throws and refuses to sign**. This is correct behavior, not a bug—it is a safe wedge that prevents a race where the account became usable after the burn was detected as unusable.

If this wedge fires, the action remains `REFUNDING`. A staff alert is triggered, and an operator must manually verify whether the destination is now usable (and should be retried as a mint) or still unusable (and should be manually refunded).

---

## 5. Updating the GRAM fee floor

The GRAM fee floor is **static**: `ceil(mintGasTon × FEE_GRAM_VIZ_PER_TON × margin × 1000)` mVIZ, computed once at config load. With defaults (`mintGasTon=0.06`, `FEE_GRAM_VIZ_PER_TON=500`, `margin=1.5`) the floor is **45,000 mVIZ (45 VIZ)**.

All operators must use the same value — it is set in `federation.json` (manifest wins over env):

```json
{ "fees": { "gramVizPerTon": 500 } }
```

**When to update:**
- TON price moves enough that the derived floor no longer covers gas + margin.
- After a federation upgrade that changes gas constants in `federation.json`.

**Procedure:** update `gramVizPerTon` in `federation.json` and redeploy the coordinator and all signers together. A mismatch between operators will cause signature-merge failures (determinism requirement).
