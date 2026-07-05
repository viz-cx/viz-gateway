# Plan — Prove real N-of-M federation (independent operators)

**Status:** planned, not started. Authored 2026-07-02 against `main` = `bf0f1aa`.
**Goal:** run the gateway as a genuine multi-party threshold system — M independent
operator processes, each holding exactly ONE key, communicating to reach threshold —
and prove it end-to-end. Every proof to date has been single-holder (1-of-1 TON,
2-of-2 Solana on one machine, VIZ active-only single key). The threshold *logic* is
already unit-proven, but never across real independent processes, and TON's multi-party
path does not exist yet.

## What is already true (verified, do not re-derive)

- **Coordinator is generic N-of-M and keyless.** `packages/coordinator/src/orchestrator.ts:116-141`
  builds one shared proposal, fans out over `this.signers`, accumulates via
  `ApprovalSet` (`packages/common/src/threshold.ts`), breaks at threshold, then
  broadcasts the collected signatures. Comment at `index.ts:12`: "Works at 1-of-1
  (solo) and unchanged at 7-of-11." It holds no keys → worst case is a liveness stall.
- **Production transport already exists but is unexercised at M>1.** `coordinator/src/index.ts:21-23`
  maps `SIGNER_ENDPOINTS` (comma-separated HTTP URLs, `config.ts:240`) to
  `HttpSignerClient`s. Each signer is a separate HTTP service (`packages/signer/src/index.ts`)
  that re-validates the proposal (F2, `sourceValidator.ts`) and signs with its own key.
- **Threshold behavior is unit-proven IN ONE PROCESS.** `tools/orchestration-spike.cjs`
  drives 1-of-1 and 2-of-3 with real `KeyedSigner`s and real VIZ signatures, and asserts:
  stops at threshold, refuses under-threshold, ignores rogue/unknown operators. But the
  "signers" are in-memory objects, not separate processes over HTTP.
- **VIZ + Solana combine off-chain sigs into one broadcast** → generic at any threshold.
  VIZ: `viz-watcher/src/vizChain.ts` `broadcastRelease(proposal, signatures[])` (unordered set).
  Solana: `solana-watcher/src/solanaSign.ts` `buildSignedMintTx` adds each `pk:sigHex`,
  submitter partial-signs as fee payer, `verifySignatures()`.
- **Key isolation is already per-process via env.** VIZ `VIZ_SIGNING_WIF`, TON
  `GRAM_SIGNER_MNEMONIC`, Solana `SOLANA_SIGNER_SECRET`. Each signer `.env` carries only
  its own secrets. Federation manifest (`federation.json.example`, `config.ts:parseManifest`)
  holds public pubkeys + `{n, threshold}`.

## The one real gap: TON is architecturally different

TON multisig-v2 uses **on-chain approvals**, not off-chain signature combination.
`gram-watcher/src/gramChain.ts:submitMint` **explicitly ignores `_mintAuth`** (docstring
~line 205) and only does 1-of-1 self-approve-on-init. For M-of-N, each operator's
*wallet* must send an on-chain `approve` to the order-contract address. There is no
routing for this today. Also, the TON key currently lives in BOTH the signer service
and gram-watcher (`gram-watcher` calls `submitMint` directly) — a co-location that must
be split for a clean per-operator trust boundary.

---

## Phase A — Multi-process federation proof (VIZ + Solana). Mostly harness/ops.

Proves the federation *pattern* (independent processes, HTTP fan-out, threshold
accumulation, fault behavior) on the two chains whose code is already generic. Little
or no production-code change — the deliverable is a runnable multi-signer harness plus
a live proof.

1. **Multi-signer harness.** Extend `tools/e2e/` (or a new `tools/e2e/federation.ts`) to
   launch M independent signer processes, each with its own `.env` holding exactly one
   operator's keys, on distinct ports; a coordinator with `SIGNER_ENDPOINTS` listing all
   M; a manifest at `{n: M, threshold: T}`. Reuse the existing e2e store/config plumbing.
2. **Happy-path proof.** Drive a real peg (start with VIZ peg-out on mainnet small-amount
   per testing-strategy, and Solana peg-in on devnet) through the HTTP fan-out. Assert the
   coordinator collected exactly T approvals from T distinct processes and broadcast once.
3. **Fault-matrix proof (the point of federation).** Reproduce the spike's guarantees but
   across processes: (a) T-1 signers up → no broadcast (liveness stall, no theft);
   (b) one signer offline, T of remaining up → still completes; (c) a signer fed a
   tampered proposal → rejects (F2), others still reach T; (d) rogue/unknown operator id
   → ignored by `ApprovalSet`.
4. **Key-isolation assertion.** Verify no single process can access a second operator's
   key (grep env boundaries; document the deployment topology — one signer per host/pod).
5. **Doc + `npm run` target.** Add `e2e:federation`, record the proof in RUNBOOK.

**Exit criteria:** a live T-of-M (e.g. 2-of-3) VIZ peg-out and Solana peg-in completed by
independent processes, with the full fault matrix green.

## Phase B — TON on-chain M-of-N approval routing. Real code.

The substantive dev work. Makes TON a genuine M-of-N chain.

1. **Split the TON key out of gram-watcher.** gram-watcher becomes read/detect-only; TON
   signing + approval submission moves to the signer service (mirrors VIZ/Solana), so each
   operator's TON wallet key lives only in that operator's signer process.
2. **Design the on-chain approval flow.** Proposer operator sends `new_order`
   (`approve_on_init` = its own approval only, NOT auto-execute at M>1). Coordinator then
   drives the remaining T-1 operators to each send an on-chain `approve(orderSeqno/addr)`
   from their own wallet, gated on their independent F2 validation of the source event.
   Order executes on-chain once T approvals land. Decide: each operator self-submits its
   approve tx (max decentralization) vs. a relay operator submits pre-signed approvals.
3. **Idempotency under multi-proposer.** Fold in `docs/plan-ton-peg-in-idempotency.md` §5 —
   embed `action.id`/digest in the order payload so a scan-by-action-id recovery is safe
   when >1 operator can propose. Requires an on-chain message-format change + fresh proof.
4. **Wire the coordinator/orchestrator** to the TON approval flow (the fan-out shape differs
   from off-chain-sig chains — approvals are on-chain side effects, not returned bytes).
5. **Testnet proof at 3-of-5.** Deploy a test federation on TON testnet: prove threshold
   mint, crash/recovery mid-approval (no double-mint, reuse `e2e:ton:crash` harness),
   and a signer-set rotation (old signers can no longer approve).

**Exit criteria:** 3-of-5 TON peg-in mint completed by independent operator wallets on
testnet, crash-window re-proof green, rotation proof green.

---

## Sequencing recommendation

Do **Phase A first** — it's cheap (code is generic) and immediately substantiates the
core "federated multisig" claim on 2 of 3 chains. Phase B is where the real engineering
is; scope/estimate it as its own session (or split B into B1 key-split + B2 approval-flow
+ B3 testnet-proof). Phase B is the true blocker for a full three-chain N-of-M mainnet.

## Files in play

| Concern | File |
|---|---|
| Fan-out / accumulation (no change) | `packages/coordinator/src/orchestrator.ts`, `packages/common/src/threshold.ts` |
| Endpoint wiring (no change) | `packages/coordinator/src/index.ts:21-23`, `packages/common/src/config.ts:240` |
| VIZ broadcast (no change) | `packages/viz-watcher/src/vizChain.ts`, `vizSign.ts` |
| Solana broadcast (no change) | `packages/solana-watcher/src/solanaSign.ts`, `solanaChain.ts` |
| **TON split + approval routing (Phase B)** | `packages/gram-watcher/src/gramChain.ts:submitMint`, `packages/gram-watcher/src/index.ts`, `packages/signer/src/keyedSigner.ts:approveGramMint`, `packages/coordinator/src/adapters.ts:GramMintBroadcaster` |
| Multi-signer harness (Phase A) | `tools/e2e/`, new `tools/e2e/federation.ts`, `package.json` scripts |
| Manifest / config | `federation.json.example`, `.env.example` |
| In-process reference behavior | `tools/orchestration-spike.cjs` (2-of-3 assertions to mirror across processes) |
