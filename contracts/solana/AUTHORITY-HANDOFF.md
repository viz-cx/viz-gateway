# Solana Authority Hand-off Plan (interim deploy payer → federation)

Owner-approved (2026-08-22), variant **B**, amended 2026-08-23: program upgrade authority AND the
metadata authorities → the Squads v4 (2-of-3) vault PDA. The deploy-payer key is held by the
maintainer, who runs the APPLY.

> **Why not the SPL multisig for metadata (amendment):** Token-2022's token-metadata processor
> (`check_update_authority`) requires the update authority account itself to be `is_signer`; unlike
> `SetAuthority`/`MintTo` it has **no SPL-multisig path**. A `createMultisig` account can never sign,
> so handing `updateAuthority` to `Bkyv7EU75…` would succeed on-chain and freeze metadata forever.
> The Squads vault PDA CAN sign (via CPI on proposal execution), so metadata goes there too —
> `enforceMetadataAuthority.ts` refuses an SPL-multisig target outright.

## What we hand off

| Authority | Current | Target |
|---|---|---|
| Program **upgrade authority** (ProgramData `ApzVXi9…`) | deploy payer `ENPmfoRo…` | **Squads v4, 2-of-3** vault PDA (op-1 + op-2 `BEC96…` + op-3 `3s1Senk…`) |
| Metadata **updateAuthority** + metadataPointer (Token-2022 wVIZ) | deploy payer `ENPmfoRo…` | the **same Squads vault PDA** (NOT `Bkyv7EU75…` — see amendment above) |

Mint + freeze authority are already on `Bkyv7EU75…` — leave them (token instructions do support the
SPL multisig). Neither the BPF Loader nor the token-metadata interface understands SPL multisigs
(both check a single signer), so both hand-off targets must be the Squads PDA.

## Steps (in order)

### 0. Devnet dry-run (required before mainnet)
Neither enforce script has **been APPLY-tested on a live cluster** yet. Run both on devnet: fresh
deploy → `npm run authority:solana` / `npm run metadata:authority` (expect `UNSAFE` + canHandoff,
and a clean hand-off simulation from the metadata dry-run) → `APPLY=1` → re-run dry-runs →
`SECURED`. Only then mainnet.

### 1. Squads v4 multisig 2-of-3 (mainnet)
- Create a Squads v4 multisig: members = [op-1 `6WMGd1g3mRx7rKn469km6ghp7h1DRmaPQfPWQ4icGP5s`,
  op-2 `BEC96…`, op-3 `3s1Senk…`], threshold = 2.
- Record the vault PDA → `SOLANA_UPGRADE_MULTISIG` (and it doubles as `SOLANA_METADATA_AUTHORITY`,
  step 3).
- op-1 pubkey received from the owner 2026-08-23 (validated on-curve); op-1 wasn't in the Solana
  leg before — the mint multisig is 2-of-2 without them.

### 2. Upgrade authority → Squads PDA
```bash
SOLANA_DEPOSIT_PROGRAM_ID=3wp7eV7RCNoRaEie1MUvhf2qjbeBk13XZ6WpvGNihDtD \
SOLANA_UPGRADE_MULTISIG=<squads PDA> \
  npm run authority:solana          # dry-run: UNSAFE + canHandoff=true
APPLY=1 SOLANA_PAYER_SECRET=<deploy payer> \
  npm run authority:solana          # you (deploy-payer key)
npm run authority:solana            # verify: SECURED
```
(raw-CLI equivalent: `solana program set-upgrade-authority <id> --new-upgrade-authority <pda>`)

### 3. Metadata updateAuthority + metadataPointer → Squads vault PDA
- Hand off `updateAuthority` and the `metadataPointer` authority to the **Squads vault PDA from
  step 1** (never `Bkyv7EU75…` — the script hard-refuses an SPL-multisig target; see amendment).
- Script: `contracts/solana/src/enforceMetadataAuthority.ts` + `npm run metadata:authority`
  (included in this branch). APPLY is signed by the current authority = deploy payer (your key).
- The dry-run **simulates the exact hand-off transaction unsigned against the live cluster** and
  reports the result — a clean simulation is the go/no-go evidence for APPLY; no secret needed.
- Usage:
```bash
SOLANA_WVIZ_MINT=APTCgk1UGYgrCiy6B1yVBxkCuzm2K9Rtk2ZSgEiWMdDD \
SOLANA_METADATA_AUTHORITY=<squads vault PDA> \
  npm run metadata:authority                      # dry-run: UNSAFE + simulation result, exit 2
APPLY=1 SOLANA_PAYER_SECRET=<deploy payer> \
  npm run metadata:authority                      # hand off (re-verifies on-chain after send)
npm run metadata:authority                        # verify: SECURED, exit 0
```
- raw-CLI reference: `spl-token authorize <mint> metadata-pointer <new-authority>` for the pointer;
  the metadata updateAuthority is a separate spl-token-metadata interface instruction.

### 4. Verify (final)
- `npm run authority:solana` → `SECURED` (upgrade authority = Squads PDA).
- `npm run metadata:authority` → `SECURED` (updateAuthority == Squads PDA, metadataPointer
  authority == Squads PDA; `None` would also pass as `IMMUTABLE` — terminal, but not this plan's
  target).
- Confirm no `SOLANA_DEPOSIT_MASTER_SEED` is set anywhere (runbook §3b).
- Optional: run both scripts periodically (fail-closed, as designed).

### 5. Update PROVENANCE.md (PR #147)
Replace "upgrade authority INTERIM (deploy payer)" with the final state: upgrade = Squads PDA,
metadata updateAuthority + metadataPointer = the same Squads PDA.

## Who does what
- **Owner:** op-1 pubkey for the Squads 2-of-3.
- **Maintainer:** devnet dry-run; create Squads 2-of-3; run APPLY (upgrade + metadata) with the
  deploy-payer key; verify; update PROVENANCE.md.
- The metadata hand-off script is provided in this branch.

## Risks / notes
- Until hand-off, the upgrade authority is a single deploy payer — any key compromise = drain.
  Step 2 is critical and must follow Squads setup.
- Squads 2-of-3 means any 2 of 3 operators can upgrade the program or edit metadata; a single
  operator cannot. Mint/freeze stay on the 2-of-2 `Bkyv7EU75…`.
- Immutable (upgrade authority → None) is deferred as a later hardening step, not part of this plan.
