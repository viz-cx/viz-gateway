# contracts/solana — Program Provenance

## gateway-deposit

| Field | Value |
|---|---|
| Program name | `gateway_deposit` |
| Program ID | `MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1` |
| Anchor version | `1.1.2` |
| Rust toolchain | `1.89.0` (pinned in `rust-toolchain.toml`) |
| Source | `contracts/solana/programs/gateway-deposit/` |
| IDL | `contracts/solana/target/idl/gateway_deposit.json` |
| Binary | `contracts/solana/target/deploy/gateway_deposit.so` |
| Deploy keypair | `contracts/solana/target/deploy/gateway_deposit-keypair.json` |

### Purpose

Burn-only on-chain program. Accepts a single instruction — `burn_deposit` — that:
1. Re-derives the PDA `["deposit", viz_account]` from the calling program ID.
2. Burns exactly `amount` tokens from the PDA's ATA via Token-2022 CPI.

There is **no transfer instruction**. Funds at a PDA can only be burned; they cannot be
moved to any other address. The PDA has no private key — it is a program-derived address
with bump-seed authority held by the program itself.

### Upgrade authority

On devnet/mainnet deploy, the upgrade authority **must be set to the M-of-N multisig**
(same set as the wVIZ mint authority). This prevents unilateral program upgrades and
requires operator consensus to change the burn logic.

To set after deploy:
```bash
solana program set-upgrade-authority MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1 \
  --new-upgrade-authority <MULTISIG_ADDRESS> \
  --url <RPC_URL>
```

To verify:
```bash
solana program show MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1 --url <RPC_URL>
# Authority field must equal the multisig address
```

### Devnet proof

Verified locally via `tools/solana-pegout-proof.cjs` (see §5 of `RUNBOOK.md`).
The proof deploys the program to a fresh `solana-test-validator`, mints wVIZ to the
deposit PDA ATA, calls `burn_deposit`, and asserts the balance and supply dropped by
the burned amount.
