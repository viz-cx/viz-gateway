# contracts/solana — Program Provenance

## gateway-deposit

| Field | Value |
|---|---|
| Program name | `gateway_deposit` |
| Program ID | id-agnostic — no `declare_id!`; the PDA is derived from the runtime program id, so one build deploys under any id (localnet used `MCFeMZJY…`, devnet ids in runbook) |
| SDK | `pinocchio 0.11` (no_std; replaced Anchor 2026-08-20 — .so 134,120 → ~16 KB, deploy rent ~0.94 → ~0.12 SOL) |
| Rust toolchain | `1.89.0` (pinned in `rust-toolchain.toml`), built with `cargo build-sbf` |
| Source | `contracts/solana/programs/gateway-deposit/` |
| IDL | `contracts/solana/target/idl/gateway_deposit.json` |
| Binary | `contracts/solana/target/deploy/gateway_deposit.so` |
| Deploy keypair | `contracts/solana/target/deploy/gateway_deposit-keypair.json` |

### Purpose

Burn-only on-chain program. Accepts a single instruction — `burn_deposit` — that:
1. Re-derives the PDA `["deposit", viz_account]` from the calling program ID.
2. Burns exactly `amount` tokens from the PDA's ATA via Token-2022 CPI.

The wire ABI is frozen at the original Anchor layout (discriminator
`sha256("global:burn_deposit")[..8]`, Borsh args, Anchor error codes) and pinned
by `tests/test_initialize.rs` (litesvm) plus the committed IDL — the pinocchio
rewrite changed the implementation, not the interface.

There is **no transfer instruction**. Funds at a PDA can only be burned; they cannot be
moved to any other address. The PDA has no private key — it is a program-derived address
with bump-seed authority held by the program itself.

### Upgrade authority (H3)

The burn-only guarantee holds only while the program is what we audited: whoever holds the
BPF **upgrade authority** can replace `burn_deposit` with a drain-everything instruction and
empty every deposit ATA. On devnet/mainnet deploy the upgrade authority **must be set to the
federation's M-of-N multisig**, verified on-chain, and eventually dropped (non-upgradeable).

> ⚠️ The BPF Upgradeable Loader checks a **single** authority pubkey — it does NOT understand
> SPL Token multisigs. The `createMultisig` account that gates the wVIZ *mint* authority
> therefore **cannot** serve as the upgrade authority. Use a real on-chain multisig program
> (e.g. **Squads v4**) and set its authority PDA (`SOLANA_UPGRADE_MULTISIG`) as the upgrade
> authority. Mint-authority multisig ≠ upgrade-authority multisig.

Verify + hand off with the in-repo tool (equivalent to `solana program show`, but fail-closed —
dry-run exits non-zero when the authority isn't the multisig, so CI/operators notice):
```bash
SOLANA_DEPOSIT_PROGRAM_ID=MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1 \
SOLANA_UPGRADE_MULTISIG=<SQUADS_AUTHORITY_PDA> \
  npm run authority:solana                       # dry-run: read + verdict, no writes
# to reassign (the CURRENT authority must sign):
APPLY=1 SOLANA_PAYER_SECRET='[..]' ... npm run authority:solana
```
Or the raw CLI equivalent:
```bash
solana program set-upgrade-authority MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1 \
  --new-upgrade-authority <SQUADS_AUTHORITY_PDA> --url <RPC_URL>
solana program show MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1 --url <RPC_URL>  # Authority == multisig
```

> **Not tested on a live cluster.** No `solana-test-validator` is available in the dev
> environment, so `enforceProgramAuthority.ts`'s on-chain read/hand-off path has NOT been run
> against a cluster. Its ProgramData parsing, PDA derivation, fail-closed verdict, and the
> `SetAuthority` instruction layout are covered offline by
> `tools/solana-upgrade-authority-spike.cjs`; dry-run it on devnet before mainnet.

### Devnet proof

Verified locally via `tools/solana-pegout-proof.cjs` (see §5 of `RUNBOOK.md`).
The proof deploys the program to a fresh `solana-test-validator`, mints wVIZ to the
deposit PDA ATA, calls `burn_deposit`, and asserts the balance and supply dropped by
the burned amount.
