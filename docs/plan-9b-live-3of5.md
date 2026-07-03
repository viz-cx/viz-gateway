# Plan — §9b LIVE 3-of-5 TON peg-in proof (real on-chain M-of-N)

**Status:** NOT STARTED (authored 2026-07-03). Resume in a fresh session.
**Milestone:** last "prove it live" item on the Phase B federation track.
**Predecessor:** Phase B code MERGED (PR #19, `main` @ `df5b5cc`) — coordinator
keyless on TON, operators approve on-chain from their own wallets, offline 3-of-5
spike (`tools/ton-onchain-approval-spike.cjs`) green in CI.
**Goal:** prove the Phase B trust boundary *live on TON testnet* — 5 independent
operator wallets, a keyless coordinator, a mint that only lands once 3 distinct
operators approve on-chain — through §9b's 4 exit criteria in `RUNBOOK.md`.

---

## Why this isn't just "run the checklist"

Two code gaps block a live 3-of-5 run (both found 2026-07-03):

1. **The federation harness wires no per-operator TON mnemonic.**
   `tools/e2e/federation-config.ts` threads only `FED_OP<i>_WIF` (VIZ) and an
   optional `FED_OP<i>_SOLANA_SECRET`. The signer builds its `TonApprover` from
   `cfg.ton.signerMnemonic` (`TON_SIGNER_MNEMONIC`), which today comes from the
   *shared* base env — so all N signers would share ONE TON wallet. A real 3-of-5
   needs each signer to approve from its **own** TON wallet.
   → `packages/signer/src/index.ts:98-107` gates `TonApprover` on
   `jettonMinterAddress && multisigAddress && signerMnemonic`; the multisig+minter
   are shared, only the mnemonic must be per-operator.

2. **No live TON 3-of-5 driver exists.** `tools/e2e/federation-live.ts` proves the
   *2-of-3 VIZ peg-out* (Phase A). It uses the TON path only 1-of-1 for the peg-in
   leg. Nothing drives a TON peg-in through 3 independent on-chain approvals, nor
   the under-threshold / crash-window / rotation criteria.

Plus one operational prep gap:

3. **A fresh 3-of-5 `multisig.data.boc`** must be generated from the official
   `Multisig.configToCell({threshold:3, signers:[5 addrs], proposers:[], allowArbitrarySeqno:false})`
   wrapper. The vendored `contracts/ton/boc/multisig.data.boc` is the old set.

And one hard human prereq:

4. **5 funded TON testnet wallets + a funded deployer** (faucet — human only).

---

## Work breakdown

### Task 1 — Harness: per-operator TON mnemonic (code)
- `tools/e2e/federation-config.ts`:
  - Add `tonMnemonic?: string` to the `operators[]` shape and read
    `FED_OP<i>_TON_MNEMONIC` (via `opt()`) in `loadFederationConfig`.
  - In `buildFederationRunEnv`, when `op.tonMnemonic` is set, add
    `env["TON_SIGNER_MNEMONIC"] = op.tonMnemonic` to that signer's spec (it
    overrides the shared base-env mnemonic). Leave `TON_MULTISIG_ADDRESS` /
    `TON_JETTON_MINTER_ADDRESS` coming from shared base env (same for all signers).
  - Update the header doc comment (env var list) to include `FED_OP<i>_TON_MNEMONIC`.
- `.env.e2e.example`: add `FED_OP{1..5}_TON_MNEMONIC=""` under the federation
  section and note it's per-operator (each signer's own TON wallet).
- **Acceptance:** launching a federation stack with 5 distinct
  `FED_OP<i>_TON_MNEMONIC` gives each signer a `TonApprover` configured with its
  own wallet (verify via signer startup log — TON approver wired).

### Task 2 — Live driver: `tools/e2e/federation-ton-live.ts` (code)
Model it on `federation-live.ts` but drive a **TON peg-in** through the keyless
coordinator + 5 signers. Config: `FED_N=5`, `FED_THRESHOLD=3`. Coordinator runs
with NO `TON_SIGNER_MNEMONIC` (keyless); it designates the **first** federation
operator as proposer, so order `SIGNER_ENDPOINTS` with that signer first
(`launchFederationStack` already assembles endpoints from `signerSpecs` order).

Four sub-proofs (§9b steps 4-7), each asserting on wVIZ jetton supply/balance
delta via `tools/e2e/ton.ts` helpers (`tonWvizBalance`) + `deltas.ts`:

1. **Threshold mint (step 4):** drive a peg-in (`submitLock` with memo =
   `ton:<owner>`). Expect proposer sends `new_order` (1/3), next two send `approve`
   (2/3 → 3/3 executes); coordinator `broadcast` polls `orderExecuted`. Assert
   wVIZ supply +`net` exactly.
2. **Under-threshold (step 5):** stop 3 of 5 signers, drive another peg-in; ≤2
   approvals land, order never executes, no wVIZ minted. Assert delta 0 within a
   bounded wait.
3. **Crash-window (step 6):** kill the coordinator after `new_order` but before
   threshold, restart, re-drive. Proposer's signer finds its order already exists
   (no 2nd `new_order`); remaining approvals complete the SAME order. Assert supply
   +`net` exactly once (no double-mint). (Reuse the crash-recovery pattern in
   `tools/e2e/crash-recovery.ts`.)
4. **Rotation (step 7):** rotate the multisig signer set (drop an old operator);
   the dropped operator's `approve` is rejected on-chain (err 106
   `unauthorized_sign`), the new set reaches threshold. (May reuse
   `contracts/ton/src/rotateTon.ts` / `tonRotation.ts`.)

- Add npm target `e2e:federation:ton:live` in `package.json` (mirror
  `e2e:federation:live`: `npm run build && node tools/e2e/dist/federation-ton-live.js`).
- **Acceptance:** all 4 sub-proofs pass live on testnet; log a clear PASS banner
  per criterion.

### Task 3 — 3-of-5 multisig data BOC (tooling / operational)
- Generate the 5 operator TON wallets (24-word mnemonics + v4 addresses). Store
  secrets in a **gitignored** `docs/federation-ton-keys.md` (mirror
  `docs/federation-keys.md`). Record the 5 addresses (order matters — fixes each
  operator's `signers[index]`).
- Build the data BOC:
  `Multisig.configToCell({threshold:3, signers:[5 Address], proposers:[], allowArbitrarySeqno:false}).toBoc()`
  → write to a new `multisig.data.boc` (do NOT overwrite the vendored one used by
  the CI spike — use a separate path, e.g. `contracts/ton/boc/multisig-3of5.data.boc`,
  and point `MULTISIG_DATA_BOC` at it for the deploy).
- **Acceptance:** `npm run deploy:multisig` (dry-run) prints the computed address
  and `3-of-5`.

### Task 4 — Operational deploy (human-gated, run last)
Prereq: fund the 5 operator wallets + the deployer wallet (faucet). Then, per
`RUNBOOK.md` §9b + `contracts/ton/README.md` steps 3-4:
1. `DEPLOY_SEND=1 npm run deploy:multisig` → record `TON_MULTISIG_ADDRESS`.
2. `DEPLOY_SEND=1 npm run deploy:minter` → record `TON_JETTON_MINTER_ADDRESS`.
3. `DEPLOY_SEND=1 MINTER_ADDRESS=… MULTISIG_ADDRESS=… npm run set-minter-admin`
   (hand the wVIZ minter admin to the fresh 3-of-5 multisig).
4. Fill `.env.e2e`: `E2E_TON_MULTISIG_ADDRESS`, `E2E_TON_JETTON_MINTER_ADDRESS`,
   `FED_N=5`, `FED_THRESHOLD=3`, `FED_OP{1..5}_ID/WIF/TON_MNEMONIC`.
5. `npm run e2e:federation:ton:live` → run the 4 criteria.

---

## Exit criteria (from RUNBOOK §9b)
- [ ] threshold mint by independent wallets ✔
- [ ] under-threshold no-mint ✔
- [ ] crash-window single-mint ✔
- [ ] rotation rejects old signers ✔

On completion: update `RUNBOOK.md` §9b with the proof record (addresses, tx
hashes, run id), flip the SUMMARY open task, and write a memory note.

---

## Key references
- `RUNBOOK.md` §9b (lines ~290-324) — the operational checklist this plan automates.
- `contracts/ton/README.md` steps 1-4 — deploy multisig/minter, hand admin.
- `packages/signer/src/index.ts:98-107` — `TonApprover` wiring (gated on mnemonic).
- `packages/ton-watcher/src/tonApprove.ts` — `TonApprover` (propose/approve from own wallet).
- `tools/e2e/federation-config.ts` — where the per-op TON mnemonic must be threaded.
- `tools/e2e/federation-live.ts` — the driver to model `federation-ton-live.ts` on.
- `tools/ton-onchain-approval-spike.cjs` — offline 3-of-5 proof (the on-chain flow, already green).
- `docs/plan-ton-onchain-approval.md` — Phase B design (IMPLEMENTED), the trust boundary being proven.
