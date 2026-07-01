# Plan — TON peg-out source validation (signer F2 for TON)

**Status:** planned — implement in a dedicated session.
**Severity:** 🟠 — liveness blocker: TON peg-out cannot complete until this lands (the
signer correctly fail-closes). Not a theft vector (fail-closed is safe), but the single
thing between here and a green TON round-trip.
**Prereq context:** TON testnet is deployed and **peg-in is proven end-to-end**
(2026-07-01). See [[ton-testnet-deployed-2026-07-01]] memory + `RUNBOOK.md`.
**Related:** [[plan-f2-signer-source-validation]] (the Solana/VIZ F2 that this mirrors).

---

## Problem

`packages/signer/src/sourceValidator.ts:94-102` fail-closes on **every** TON peg-out:
the signer refuses to sign the VIZ release because it cannot independently re-read the
TON burn event. The code comment cites "sourceId is a message hash; toncenter v2 has no
clean fetch-by-hash." Verified live 2026-07-01: peg-in mints fine, the peg-out wVIZ
transfer lands at the gateway jetton wallet, then the release stalls here.

There is **no runtime bypass** — `DISABLED_SOURCE_VALIDATION` (keyedSigner.ts) is a
test-only sentinel, not wired to the service.

## What a TON peg-out source event is (confirmed)

- ton-watcher (`tonChain.ts:finalizedBurnsSince`) watches the **gateway jetton wallet**
  (`TON_GATEWAY_JETTON_WALLET`) for a TEP-74 `transfer_notification` (0x7362d09c).
- It builds a `RemoteBurn`:
  - `sourceId = tx.hash().toString("hex")` — the burn tx hash (64 hex chars). **This is
    the action.id.**
  - `from = parsed.sender`, `amountMilliViz = parsed.amountBaseUnits` (3-decimal jetton),
    `homeDestination = parsed.comment.trim()` (the **VIZ recipient**, on-chain in the
    transfer comment).
- `canonicalPegOut(burn)` (canonical.ts:73) is **chain-agnostic**: digest binds
  `src` (tx hash) + `recipient` (comment) + `amount`. No `remoteChain` field is set, so
  no per-chain divergence vs the Solana path. **No deposit-address registry is needed for
  TON** — unlike Solana, the destination is the on-chain comment, which the signer reads
  directly. This makes TON validation simpler than Solana's.

## Approach

Independent re-read by **bounded scan of the gateway jetton wallet's own transactions**
(we know that address from config; the sourceId alone lacks lt/address for a direct
fetch). Mirror `finalizedBurnsSince`, filtered to the matching tx hash, with the same
finality buffer. This is the honest re-derivation: the operator's own TON node returns
the burn, comment, and amount; a compromised coordinator cannot forge it.

## Tasks (TDD)

1. **`TonHttpChain.getBurn(sourceId): Promise<RemoteBurn | null>`** (`tonChain.ts`).
   - `getTransactions(this.gatewayWallet, { limit: this.maxTransactions })`, find the tx
     with `tx.hash().toString("hex") === sourceId`.
   - Apply the SAME `finalityBufferSec` cutoff as `finalizedBurnsSince` (reject
     not-yet-final → return null → fail-closed stall).
   - Parse via `parseTransferNotification`; return `RemoteBurn` (homeDestination = comment)
     or `null` if not found / not a transfer_notification / not yet final.
   - Refactor: factor the per-tx parse out of `finalizedBurnsSince` so both share it.
   - Implements the existing `BurnReader` interface (`getBurn`) — no new type.

2. **sourceValidator.ts — add the TON peg-out branch** (replace the throw at :100).
   - Add `tonChain: BurnReader` to `SourceValidatorDeps`.
   - Discriminate by **id shape** (honest, not attacker-controlled `remoteChain`):
     Solana sig = base58 86-90 (existing regex); TON tx hash = `/^[0-9a-f]{64}$/i`.
     If TON-shaped → `validateTonPegOut`: `burn = await deps.tonChain.getBurn(action.id)`,
     null → SourceMismatchError; else `assertSameAction(canonicalPegOut(burn), action)`.
   - Keep the final `throw` for ids matching neither shape (still fail-closed).

3. **signer/index.ts — wire a read-only TON reader** into `validatorDeps`.
   - Construct from the operator's OWN `cfg.ton` (endpoint, apiKey, jettonMinterAddress,
     gatewayJettonWallet). `getBurn` needs only client + gatewayWallet (no mnemonic).
   - If `cfg.ton.gatewayJettonWallet` is unset → fail-closed stub (mirror the Solana stub
     at index.ts:40).
   - INDEPENDENCE LINCHPIN comment: the TON endpoint MUST be the operator's own node.

4. **Offline spike `tools/ton-pegout-f2-spike.cjs`** (mirror `signer-f2-spike.cjs`).
   - Construct a `transfer_notification` cell → drive `getBurn` (mock client returning the
     tx) → `validateAction` → assert: (a) matching burn validates, (b) tampered
     amount/recipient/id → SourceMismatchError, (c) not-final → null → refuse.
   - Add to the `verify` script in `package.json` (the long `&&` chain).

5. **e2e verification** — re-run `tools/e2e/run-local.sh`. Expect the full round trip:
   `ROUND TRIP OK: released <net> mVIZ to <recipient>`. The prior run already proved peg-in
   and left 10,314 wVIZ at the gateway jetton wallet + a stalled release; a fresh run does a
   clean cycle. (Signer wallet is funded; burn wallet is provisioned.)

## Gotchas / notes

- **Bounded-scan window:** `getBurn` only sees the last `maxTransactions` (default 20) of
  the gateway wallet. A release delayed past that window can't be validated → stall. If
  gateway throughput is high, paginate (getTransactions supports lt/hash cursors) or raise
  the limit. Document the bound; do not silently cap.
- **tx.hash() consistency:** the signer must hash the tx identically to ton-watcher (same
  `@ton/ton` `Transaction.hash()`). Same lib → consistent; assert in the spike.
- **Finality buffer parity:** reuse the exact cutoff from `finalizedBurnsSince` so the
  signer never validates a burn the watcher wouldn't have treated as final.

## Related gap (decide in this session, may be separate task)

**FEE_SWEEP / REFUND also 500 at the signer.** Observed live: `<id>:fee` (FEE_SWEEP) hits
the same fail-closed peg-out branch (its id is neither a Solana sig nor a TON hash). These
are **gateway-internal VIZ releases with no remote source event**, so source re-read
doesn't apply. They need a different validation: e.g. re-derive the sweep from the
PEG_IN it settles (amount = withheld fee, target = `fees.gate`), or validate against
policy. Without it, fees never sweep and `recon` will show `unswept > 0` indefinitely.
Scope this as task 6 or a follow-up plan — it does not block the peg-out release itself.

## Files

- `packages/ton-watcher/src/tonChain.ts` — add `getBurn`, factor out the parse.
- `packages/signer/src/sourceValidator.ts` — TON branch + `tonChain` dep.
- `packages/signer/src/index.ts` — wire the read-only TON reader.
- `tools/ton-pegout-f2-spike.cjs` + `package.json` verify chain.
- (optional) `packages/signer/src/*` FEE_SWEEP validation for the related gap.
