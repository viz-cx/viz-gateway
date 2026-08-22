# Solana Authority Hand-off Plan (interim deploy payer → federation)

Owner-approved (2026-08-22), variant **B**: program upgrade authority → Squads v4 (2-of-3);
metadata updateAuthority + metadataPointer → the existing SPL multisig. The deploy-payer key is
held by the maintainer, who runs the APPLY.

## What we hand off

| Authority | Current | Target |
|---|---|---|
| Program **upgrade authority** (ProgramData `ApzVXi9…`) | deploy payer `ENPmfoRo…` | **Squads v4, 2-of-3** (op-1 + op-2 `BEC96…` + op-3 `3s1Senk…`) |
| Metadata **updateAuthority** + metadataPointer (Token-2022 wVIZ) | deploy payer `ENPmfoRo…` | **SPL multisig `Bkyv7EU75…`** (already exists, 2-of-2: op-2 + op-3) |

Mint + freeze authority are already on `Bkyv7EU75…` — leave them. Upgrade authority cannot be an
SPL multisig (the BPF Loader checks a single pubkey), so it must be Squads, not `Bkyv7EU75…`.

## Steps (in order)

### 0. Devnet dry-run (required before mainnet)
`enforceProgramAuthority.ts` has **not been tested on a live cluster** yet (as PROVENANCE.md
states). Run on devnet: fresh deploy → `npm run authority:solana` (expect `UNSAFE`, canHandoff) →
`APPLY=1` → re-run dry-run → `SECURED`. Only then mainnet.

### 1. Squads v4 multisig 2-of-3 (mainnet)
- Create a Squads v4 multisig: members = [op-1, op-2 `BEC96…`, op-3 `3s1Senk…`], threshold = 2.
- Record the authority PDA → `SOLANA_UPGRADE_MULTISIG`.
- ⚠️ Requires the **op-1 pubkey** (provided by the owner; he wasn't in the Solana leg before —
  the mint multisig is 2-of-2 without him).

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

### 3. Metadata updateAuthority → SPL multisig `Bkyv7EU75…`
- Hand off `updateAuthority` and the `metadataPointer` authority to `Bkyv7EU75…`.
- Script: `contracts/solana/src/enforceMetadataAuthority.ts` + `npm run metadata:authority`
  (included in this branch). It is signed by the current authority = deploy payer (your key).
- **The write path is already verified** against the live mainnet Token-2022 program via
  differential `simulateTransaction`: both `UpdateMetadata(updateAuthority)` and
  `SetAuthority(MetadataPointer)` execute cleanly, and a corrupted instruction discriminator is
  correctly rejected. The only remaining gate is the real deploy-payer signature.
- Usage:
```bash
npm run metadata:authority                        # read-only dry-run (fail-closed)
APPLY=1 SOLANA_PAYER_SECRET=<deploy payer> \
  npm run metadata:authority                      # hand off
npm run metadata:authority                        # verify: SECURED
```
- raw-CLI reference: `spl-token authorize <mint> <authority-type> <new-authority>` for
  metadataPointer; the metadata updateAuthority is a separate spl-token-metadata instruction.

### 4. Verify (final)
- `npm run authority:solana` → `SECURED` (upgrade authority = Squads PDA).
- Mint `getAccountInfo` → `updateAuthority == Bkyv7EU75…`, metadataPointer authority == `Bkyv7EU75…`.
- Optional: run `npm run authority:solana` periodically (fail-closed, as designed).

### 5. Update PROVENANCE.md (PR #147)
Replace "upgrade authority INTERIM (deploy payer)" with the final state: upgrade = Squads PDA,
metadata updateAuthority = `Bkyv7EU75…`.

## Who does what
- **Owner:** op-1 pubkey for the Squads 2-of-3.
- **Maintainer:** devnet dry-run; create Squads 2-of-3; run APPLY (upgrade + metadata) with the
  deploy-payer key; verify; update PROVENANCE.md.
- The metadata hand-off script is provided in this branch.

## Risks / notes
- Until hand-off, the upgrade authority is a single deploy payer — any key compromise = drain.
  Step 2 is critical and must follow Squads setup.
- Squads 2-of-3 means any 2 of 3 operators can upgrade the program; a single operator cannot.
  Metadata is on the 2-of-2 `Bkyv7EU75…` — same threshold as the mint.
- Immutable (upgrade authority → None) is deferred as a later hardening step, not part of this plan.
