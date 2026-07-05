# Plan — Mainnet deployment

**Status:** NOT STARTED. Handoff artifact prepared 2026-07-05 (`main` @ `4ee0cd5`).
**Decision on record (2026-07-05):** proceed to mainnet **before** the R-1 external audit —
audit is *deferred*, risk explicitly accepted by the operator. The R-1 handoff package
(`docs/AUDIT.md`, pinned `a25f425`) stays send-ready for a later engagement; it is **not** a
blocker for this deploy.

> This consolidates the per-chain steps that today live testnet-oriented in `RUNBOOK.md`
> (§4 VIZ accounts, §5 config, §5 Solana cutover, §6 TON gas, §9/§9b proofs) into one
> mainnet-sequenced checklist. Execute in a fresh session; resolve Phase 0 decisions first.

---

## Phase 0 — Decisions & pre-flight (resolve before touching any chain)

These are operator decisions, not code. Each materially changes later phases.

1. **Federation size & operators.** Target is **5-of-7** (BFT-clean for f=2). Today VIZ
   `tester4` is 2-of-3 and TON multisig is permanently 3-of-4 (testnet). Decide: launch at
   the current small set and grow, or stand up the full 5-of-7 first? Who are the 7
   *independent* operators, and are their keys generated on separate hardware?
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

- [ ] Create/verify the **per-network backing accounts** on VIZ mainnet: `gram.gate`,
      `solana.gate`, and `fees.gate` (RUNBOOK §4). These must be distinct (the
      `gatewayAccounts.ts` registry is injective, fail-closed).
- [ ] Upgrade the gateway VIZ account to the **target N-of-M active authority** at the size
      chosen in Phase 0 (`tools/federation-authority-setup.cjs`, dry-run then `APPLY=1`;
      omit `master` for active-only change). Master key stays offline.
- [ ] Confirm live authority hash matches the intended keyset (anti-rollback).

## Phase 2 — Solana mainnet (remote: mint / burn, PDA custody)

Currently devnet (program `MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1`, Anchor 1.1.2).

- [ ] Reproducible-build `gateway_deposit`; **deploy to Solana mainnet**; verify the program
      ID matches the pinned value; record in `contracts/solana/PROVENANCE.md`.
- [ ] **Set upgrade authority to the M-of-N multisig** (RUNBOOK §5) — this is the only escape
      hatch on the burn-only program; leaving it on a single key defeats T5.
- [ ] Deploy the **wVIZ SPL mint** with mint authority = the on-chain SPL M-of-N multisig
      (never the submitter). Create the durable **nonce account**.
- [ ] Fund the **submitter** (`SOLANA_SUBMITTER_SECRET`) with SOL (fee payer + nonce authority
      + ATA rent). Set `SOLANA_SUBMITTER_PUBKEY` so signers pin `feePayer`.
- [ ] Set `SOLANA_DEPOSIT_PROGRAM_ID`; confirm **no** `SOLANA_DEPOSIT_MASTER_SEED` /
      `DEPOSIT_MASTER_PUB` anywhere (retired in R-6).

## Phase 3 — TON mainnet (remote: mint / burn)

Currently testnet (multisig `EQCuW98I…` 3-of-4, minter deployed testnet).

- [ ] Deploy **multisig-v2** at the target N-of-M on TON mainnet (`contracts/ton`,
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
- [ ] Under-threshold drill (kill M-T+1 signers → broadcast:false, no theft).
- [ ] Pause drill (1-of-N trips pause; signers return 423).
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
