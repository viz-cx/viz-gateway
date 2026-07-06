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
- **Grow trigger (2026-07-06):** grow **2-of-3 → 5-of-7 by adding independent operators as they
  come online** — operator-availability driven, not time/volume gated. Launch value stays small
  until the set grows.
- **Still open (Phase 0 not yet closed):** (a) the 3 *independent* launch operators — who they are,
  keys generated on separate hardware (see the **operator key-collection protocol** in Phase 0
  item 1); (c) secrets & funding staged (item 6) — **nothing staged yet**.

> This consolidates the per-chain steps that today live testnet-oriented in `RUNBOOK.md`
> (§4 VIZ accounts, §5 config, §5 Solana cutover, §6 TON gas, §9/§9b proofs) into one
> mainnet-sequenced checklist. Execute in a fresh session; resolve Phase 0 decisions first.

---

## Phase 0 — Decisions & pre-flight (resolve before touching any chain)

These are operator decisions, not code. Each materially changes later phases.

1. **Federation size & operators.** *Decided (2026-07-06):* **launch at 2-of-3** (3 independent
   operators), then grow toward **5-of-7** (BFT-clean for f=2) **by adding operators as they come
   online** (availability-driven, not time/volume gated). At 2-of-3 no single operator can act
   alone (threshold 2), but any 2 colluding can — keep launch value small until the set grows.
   Today VIZ `tester4` is 2-of-3 and TON multisig is permanently 3-of-4 (testnet); mainnet deploys
   fresh at 2-of-3. **Still to nail down:** who are the 3 *independent* launch operators and are
   their keys generated on separate hardware.

   **Operator key-collection protocol (2-of-3, TON-only launch).** The whole point of M-of-N is
   that *no single box holds a quorum of keys* — so each operator generates their own key material
   locally and sends the coordinator **public values only**:
   - **VIZ active key** — operator generates a VIZ keypair on their own box, keeps the private WIF
     (`VIZ_SIGNING_WIF`, sealed in their own `FED_KEYSTORE`), sends the coordinator the **public key**
     `VIZ7…`. The three pubkeys become `ACTIVE_KEYS` with `ACTIVE_THRESHOLD=2`.
   - **TON wallet** — operator generates a 24-word v4 wallet locally, keeps the mnemonic
     (`GRAM_SIGNER_MNEMONIC`, sealed), sends the coordinator the derived **v4 address** `EQ…`
     (workchain 0, mainnet). The three addresses build the multisig via
     `gen:multisig-data` in **addresses-only mode** (`MULTISIG_SIGNER_ADDRESSES=<a,b,c>`) so **no
     operator mnemonic ever reaches the coordinator's box**.
   - **Solana** — deferred (Phase 2); no Solana key collected at launch.
   - ⚠️ **Never collect** `VIZ_SIGNING_WIF` or `GRAM_SIGNER_MNEMONIC` from an operator — if the
     coordinator holds ≥2 operators' secrets the 2-of-3 is fake (effectively 1-of-1). Fix operator
     order (op-1/2/3) once: TON `signers[index]` is baked into the multisig address.
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
6. **Secrets & funding.** *Status (2026-07-06): **nothing staged yet.*** Checklist:
   - [ ] Each operator's secrets sealed in their **own** `FED_KEYSTORE` (per the key-collection
         protocol in item 1) — coordinator holds only the public keys/addresses.
   - [ ] VIZ **master/guardian key held offline** (`gate` key; active-only 2-of-3 on the gate accounts).
   - [ ] **VIZ backing balance** on `gram.gate` — **small at launch** (grow with the operator set).
   - [ ] **TON multisig gas** on the mainnet multisig (~0.05–0.1 TON per first peg-in).
   - [ ] Solana submitter SOL — **deferred** (Phase 2, out of the TON-only launch scope).

---

## Phase 1 — VIZ mainnet (home chain: lock / release)

VIZ is already live (prod rotation proven 2026-07-01). Remaining:

- [ ] **Create the subaccounts first.** Verified on mainnet 2026-07-06: `gate` exists (1-of-1,
      key `VIZ7bHca…`) but `gram.gate` / `fees.gate` / `solana.gate` **do not exist** — they are
      dotted subaccounts, so only `gate` can create them (small account-creation fee each). For the
      **TON-only launch** create `gram.gate` (backing) + `fees.gate` (shared fees); skip
      `solana.gate` until Phase 2. `setup:viz-account` sets authorities on an *existing* account —
      it does not create it.
- [ ] Verify the VIZ mainnet accounts (RUNBOOK §4, `npm run setup:viz-account`):
      - **Per-network backing:** `gram.gate` (and `solana.gate` at Phase 2) — the
        `gatewayAccounts.ts` registry is injective + fail-closed, so these must be distinct.
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

- [ ] Deploy **multisig-v2** at **2-of-3** on TON mainnet (`contracts/ton`, `gen:multisig-data`
      in **addresses-only mode**: `MULTISIG_SIGNER_ADDRESSES=<op1,op2,op3>` `MULTISIG_THRESHOLD=2`
      — builds the multisig from the collected operator addresses with no mnemonic on this box);
      verify cell hashes against `contracts/ton/boc/PROVENANCE.md`.
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
