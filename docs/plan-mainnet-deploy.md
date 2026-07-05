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
2. **Key custody.** `AUDIT.md §8` flags that signer keys are in **process memory** (scaffold;
   `keyedSigner.ts` comment says production wraps HSM/KMS). Deploying real value on in-memory
   WIFs/mnemonics is the single largest un-audited operational risk. Decide: HSM/KMS now, or
   accept in-memory for a capped soft-launch?
3. **Production VIZ account.** `tester4` is the current on-chain gateway identity. Confirm it
   is the intended production account, or provision a dedicated one and redo the active-set
   authority upgrade.
4. **Launch scope.** Both remotes at once (TON + Solana) or one first? One-chain launch
   halves the moving parts and the recon surface.
5. **Caps.** Set conservative per-tx and rolling-24h caps (`caps.ts` / env) for the initial
   window regardless of audit posture — the cheapest blast-radius limiter.
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

## Phase 2 — Solana mainnet (remote: mint / burn, PDA custody)

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
