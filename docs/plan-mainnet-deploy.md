# Plan — Mainnet deployment

**Status:** NOT STARTED. Handoff artifact prepared 2026-07-05 (`main` @ `4ee0cd5`);
launch parameters updated 2026-07-06.
**Decision on record (2026-07-05):** proceed to mainnet **before** the R-1 external audit —
audit is *deferred*, risk explicitly accepted by the operator. The R-1 handoff package
(`docs/AUDIT.md`, pinned `a25f425`) stays send-ready for a later engagement; it is **not** a
blocker for this deploy.
**Launch parameters (2026-07-06):**
- **Federation:** launch at **2-of-3** (soft-launch), grow to **5-of-7** post-launch.
- **VIZ accounts:** per-network backing (`gram.gate`, `solana.gate`) + one **shared fee
  account** `fees.gate` across all networks.

**Phase 0 resolved (2026-07-06):**
- **Launch scope:** **TON only first.** Prove a mainnet round-trip on one chain, then add Solana
  (Phase 2 deferred to a later window). Halves the recon surface for the soft-launch.
- **Key custody:** **keys stay on the operators' own local machines — HSM/KMS is NOT planned**
  (decided 2026-07-06). The custody control is the M-of-N federation itself: each operator runs
  on separate hardware under a separate person, so no external custody service is trusted and
  theft requires compromising T *independent* machines at once. Residual = persistent
  single-key exfiltration from one compromised operator box (bounded by threshold); mitigated
  locally by at-rest encryption of the key material (no plaintext WIF/mnemonic on disk/env —
  cross-platform passphrase keystore), NOT by moving keys off-box. See `AUDIT.md §8`.
- **Caps:** **unlimited at launch** (operator decision). ⚠️ This removes the compensating control
  that made in-memory keys tolerable AND disables the `OVER_24H`→fail-closed auto-pause that recon
  leans on. `caps.ts` has no off switch, so "unlimited" = set the three `CAP_*`/`MANUAL_REVIEW_*`
  env values to an effectively-infinite bigint. Combined blast radius on a key compromise or
  coordinator bug = the entire backing balance, immediately. Recorded as accepted risk.
- **VIZ identity:** **fresh dedicated accounts** — provision clean `gram.gate` / `solana.gate` /
  `fees.gate` with fresh 2-of-3 active authority; do not reuse `tester4`.
- **Still open (Phase 0 not yet closed):** (a) the 3 *independent* launch operators — who they are,
  keys generated on separate hardware; (b) concrete trigger/timeline for the 5-of-7 grow;
  (c) secrets & funding staged (item 6).

> This consolidates the per-chain steps that today live testnet-oriented in `RUNBOOK.md`
> (§4 VIZ accounts, §5 config, §5 Solana cutover, §6 TON gas, §9/§9b proofs) into one
> mainnet-sequenced checklist. Execute in a fresh session; resolve Phase 0 decisions first.

---

## Phase 0 — Decisions & pre-flight (resolve before touching any chain)

These are operator decisions, not code. Each materially changes later phases.

1. **Federation size & operators.** *Decided (2026-07-06):* **launch at 2-of-3** (3 operators)
   as a capped soft-launch, then grow toward **5-of-7** (BFT-clean for f=2) once live behavior
   is proven. At 2-of-3 no single operator can act alone (threshold 2), but any 2 colluding
   can — accept this for the soft-launch window and keep caps tight (item 5). Today VIZ
   `tester4` is 2-of-3 and TON multisig is permanently 3-of-4 (testnet); mainnet deploys fresh
   at 2-of-3. **Still to nail down:** who are the 3 *independent* launch operators, are their
   keys generated on separate hardware, and the concrete trigger/timeline for the 5-of-7 grow.
2. **Key custody.** *Decided (2026-07-06):* **keys stay local to each operator's machine; HSM/KMS
   is NOT planned.** The M-of-N federation is the custody control — each operator's key lives only
   on that operator's own hardware, under a separate person, so no external custody service is
   trusted and theft requires compromising T *independent* machines simultaneously. The one residual
   this leaves that a single-box HSM would close — persistent exfiltration of *one* operator's key
   from a compromised box — is bounded by the threshold and mitigated by **local at-rest encryption**
   of the key material (a cross-platform passphrase keystore: no plaintext WIF/mnemonic/secret on
   disk or in env files), which keeps keys on-box. See `AUDIT.md §8`.
3. **Production VIZ account.** *Decided (2026-07-06):* **provision fresh dedicated accounts**
   (`gram.gate` / `solana.gate` / `fees.gate`); do **not** reuse `tester4`. Each gets a fresh
   2-of-3 active-set authority (Phase 1).
4. **Launch scope.** *Decided (2026-07-06):* **TON only first.** Solana (Phase 2) deferred to a
   later window. Halves the moving parts and the recon surface.
5. **Caps.** *Decided (2026-07-06):* **unlimited at launch** (operator decision, risk accepted).
   ⚠️ Removes the compensating control for in-memory keys and disables the `OVER_24H`→auto-pause;
   `caps.ts` has no off switch so this is implemented as effectively-infinite `CAP_*` env values.
6. **Secrets & funding staged:** operator keys in the chosen vault; VIZ master held offline;
   Solana submitter SOL; TON multisig gas; VIZ balances for backing accounts.

---

## Phase 1 — VIZ mainnet (home chain: lock / release)

VIZ is already live (prod rotation proven 2026-07-01). Remaining:

- [ ] Create/verify the VIZ mainnet accounts (RUNBOOK §4, `npm run setup:viz-account`):
      - **Per-network backing:** `gram.gate`, `solana.gate` (one per remote; the
        `gatewayAccounts.ts` registry is injective + fail-closed, so these must be distinct).
      - **Shared fee account:** `fees.gate` — single account across all networks; FEE_SWEEP
        children land here (`sourceValidator.ts` re-derives recipient = operator's own
        `fees.gate`, never coordinator-fed). Must be distinct from every backing account.
- [ ] Upgrade **each** account's VIZ active authority to the **launch 2-of-3** keyset
      (`tools/federation-authority-setup.cjs`, dry-run then `APPLY=1`; omit `master` for an
      active-only change). Master key stays offline. Backing accounts custody value; `fees.gate`
      only accrues surcharge, but hold it under the same 2-of-3 so a swept fee can't be drained
      by one key.
- [ ] Confirm live authority hash matches the intended keyset (anti-rollback).

## Phase 2 — Solana mainnet (remote: mint / burn, PDA custody) — **DEFERRED**

> Phase 0 launch scope = **TON only first**. Solana stays devnet for the initial mainnet window;
> execute this phase after the TON round-trip is proven. Set `RECON_EXPECTED_REMOTES` to TON-only
> at launch so recon fails closed on a missing Solana remote rather than expecting one.

Currently devnet (program `MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1`, Anchor 1.1.2).

- [ ] Reproducible-build `gateway_deposit`; **deploy to Solana mainnet**; verify the program
      ID matches the pinned value; record in `contracts/solana/PROVENANCE.md`.
- [ ] **Set upgrade authority to the 2-of-3 multisig** (RUNBOOK §5) — this is the only escape
      hatch on the burn-only program; leaving it on a single key defeats T5.
- [ ] Deploy the **wVIZ SPL mint** with mint authority = the on-chain SPL **2-of-3** multisig
      (never the submitter). Create the durable **nonce account**.
- [ ] Fund the **submitter** (`SOLANA_SUBMITTER_SECRET`) with SOL (fee payer + nonce authority
      + ATA rent). Set `SOLANA_SUBMITTER_PUBKEY` so signers pin `feePayer`.
- [ ] Set `SOLANA_DEPOSIT_PROGRAM_ID`; confirm **no** `SOLANA_DEPOSIT_MASTER_SEED` /
      `DEPOSIT_MASTER_PUB` anywhere (retired in R-6).

## Phase 3 — TON mainnet (remote: mint / burn)

Currently testnet (multisig `EQCuW98I…` 3-of-4, minter deployed testnet).

- [ ] Deploy **multisig-v2** at **2-of-3** on TON mainnet (`contracts/ton`,
      `gen:multisig-data`); verify cell hashes against `contracts/ton/boc/PROVENANCE.md`.
- [ ] Deploy the **wVIZ Jetton minter** on TON mainnet; **hand minter admin to the multisig**
      (one-way — multisig dysfunction permanently locks wVIZ; verify the multisig works first).
- [ ] Fund the **multisig** with mainnet TON for mint execution + first-time recipient
      jetton-wallet deploys (~0.05–0.1 TON per first peg-in).
- [ ] Set `GRAM_*` mainnet env (endpoint, minter, gateway jetton wallet, multisig address).

## Phase 4 — Gateway stack config & launch

- [ ] Fill mainnet `.env` from `.env.example` + `config.ts`: VIZ node, `GRAM_*`, `SOLANA_*`,
      `VIZ_GATEWAY_ACCOUNT_GRAM=gram.gate`, `VIZ_GATEWAY_ACCOUNT_SOLANA=solana.gate`,
      `FEES_GATE_ACCOUNT=fees.gate`, per-operator signer env, `RECON_EXPECTED_REMOTES`, caps.
- [ ] Operator keys loaded via the Phase 0 custody choice (HSM/KMS or vault-injected env).
- [ ] Bring up watchers + signers + recon + coordinator (federated multi-process, not the
      solo docker stack). Confirm recon reports **per-chain** `locked ≥ circulating + unswept`
      healthy on an empty system.

## Phase 5 — Mainnet smoke proof & drills (small value)

- [ ] Peg-in + peg-out **round-trip per launched chain** with minimal value; confirm net mint,
      fee sweep to `fees.gate`, release, and recon drift = 0.
- [ ] Crash-window drill (kill coordinator mid-flight → no double-mint on recovery).
- [ ] Under-threshold drill (at 2-of-3, kill 2 signers → only 1 left → broadcast:false, no theft).
- [ ] Pause drill (1-of-3 trips pause; signers return 423).
- [ ] Record a mainnet verification block in `RUNBOOK.md`, mirroring the §9b testnet record.

---

## Reference map (existing material)

- `RUNBOOK.md` §4 (VIZ accounts), §5 (config + Solana deploy/upgrade-authority + cutover),
  §6 (TON gas), §9/§9b (peg-in proofs), "Rotating the operator set", "Known gaps".
- `docs/AUDIT.md` — trust model, threat claims T1–T8, component surface (deferred audit).
- `contracts/{solana,ton}/PROVENANCE.md` — bytecode pinning; update with mainnet addresses.
- `tools/federation-authority-setup.cjs` (VIZ authority), `gen:multisig-data` (TON),
  `contracts/solana/src/deployMint.ts` (Solana).
</content>
</invoke>
