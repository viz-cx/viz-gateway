# TON contracts setup

The gateway needs two on-chain pieces on TON. Neither is custom: both are
audited, off-the-shelf TON Core contracts. This directory holds the deploy and
initialization scripts (to be added in Phase 1).

## 1. Multisig (the federation)

Use `ton-blockchain/multisig-contract-v2`.

- Deploy with `signers = [7 operator ed25519 public keys]`, `threshold = 5`.
- `proposers` may be empty (operators are signers) or include watcher keys that
  can propose but not approve.
- Changing signers or threshold later requires the current 5-of-7 consensus.

Reference: https://github.com/ton-blockchain/multisig-contract-v2

## 2. Wrapped VIZ Jetton (the token)

Use `ton-blockchain/stablecoin-contract` (TEP-74 + TEP-89, mintable, has an
admin role). It ships TypeScript wrappers (`JettonMinter.ts`, `JettonWallet.ts`).

- Deploy the minter with metadata describing `wVIZ` as a bridge claim on VIZ
  (name, symbol `wVIZ`, decimals matching VIZ's 3, link to proof-of-reserves).
- **Set `admin` = the multisig address from step 1.** After this, only a 5-of-7
  consensus can mint or burn. Verify the admin handoff on testnet first.

Reference: https://github.com/ton-blockchain/stablecoin-contract

## Peg mechanics

- **Mint (peg-in):** the multisig executes an `order` that sends a `mint`
  message to the minter for `(recipient, amount)` derived from the canonical
  peg-in action.
- **Burn (peg-out):** users burn `wVIZ` from their Jetton wallet (or send to the
  gateway's Jetton wallet). The `ton-watcher` reads the burn notification and the
  VIZ side releases the locked VIZ.

## Decimals

VIZ has 3 decimals. Keep the Jetton at 3 decimals so 1 wVIZ == 1 VIZ exactly and
the reconciliation invariant is a direct integer comparison in milli-VIZ.

---

## Deploy scripts

The scripts in `src/` orchestrate deployment; they do **not** re-implement the
contracts. You supply the compiled bytecode (and, for the multisig, the init
data) built from the official audited repos. This is deliberate: a custody
bridge must run the exact audited bytecode, not a re-typed copy.

All scripts default to **DRY-RUN** (compute + print the address, no broadcast).
Set `DEPLOY_SEND=1` to actually send.

### Prerequisites — build the bytecode with Blueprint

```
# Multisig (gives you multisig code BOC + the Multisig wrapper)
git clone https://github.com/ton-blockchain/multisig-contract-v2 && cd multisig-contract-v2
npm i && npx blueprint build      # -> build/*.compiled.json (extract the code BOC)

# Jetton (recommended: stablecoin-contract; gives minter + wallet code BOCs)
git clone https://github.com/ton-blockchain/stablecoin-contract && cd stablecoin-contract
npm i && npx blueprint build
```

Export each compiled `code` cell to a `.boc` file and point the env vars at them.

### Step 1 — multisig init data (from the official wrapper)

The multisig storage layout must come from the official wrapper, not from here:

```ts
import { Multisig } from "multisig-contract-v2/wrappers/Multisig";
const cell = Multisig.configToCell({
  threshold: 5,
  signers: [/* 7 operator Address objects */],
  proposers: [],
  allowArbitrarySeqno: false,
});
require("fs").writeFileSync("multisig.data.boc", cell.toBoc());
```

### Step 2 — environment

| Var | Purpose |
|---|---|
| `TON_ENDPOINT`, `TON_API_KEY` | toncenter endpoint + key |
| `DEPLOYER_MNEMONIC` | 24-word mnemonic of a funded deployer wallet (v4) |
| `DEPLOY_SEND` | `1` to broadcast; unset/`0` = dry-run |
| `DEPLOY_VALUE_TON` | TON attached per deploy (default `0.5`) |
| `MULTISIG_CODE_BOC`, `MULTISIG_DATA_BOC` | multisig code + wrapper-built data |
| `MULTISIG_THRESHOLD`, `MULTISIG_SIGNERS` | `5` and 7 comma-separated addresses (for logging) |
| `JETTON_MINTER_CODE_BOC`, `JETTON_WALLET_CODE_BOC` | jetton code BOCs |
| `JETTON_MINTER_DATA_BOC` | optional wrapper-built minter data (overrides the built-in builder) |
| `JETTON_INITIAL_ADMIN` | initial admin (usually the deployer), handed to the multisig later |
| `WVIZ_NAME/SYMBOL/DECIMALS/DESCRIPTION/IMAGE` | TEP-64 metadata (`wVIZ`, `3` decimals) |
| `MINTER_ADDRESS`, `MULTISIG_ADDRESS` | for the admin handoff |

### Step 3 — deploy

```
npm run deploy:multisig        # dry-run: prints the multisig address
DEPLOY_SEND=1 npm run deploy:multisig

npm run deploy:minter          # dry-run: prints the minter address
DEPLOY_SEND=1 npm run deploy:minter
```

### Step 4 — hand minter admin to the multisig

After verifying the multisig works, transfer minting authority so only 5-of-7
can mint/burn:

```
MINTER_ADDRESS=... MULTISIG_ADDRESS=... npm run set-minter-admin       # dry-run
DEPLOY_SEND=1 MINTER_ADDRESS=... MULTISIG_ADDRESS=... npm run set-minter-admin
```

### Offline verification

`node contracts-ton/tools/verify-offline.cjs` checks the wVIZ metadata
round-trip, the standard minter init-data + address computation, the
`change_admin` body, and deployer-wallet derivation — no network or BOCs needed.

## Caveats

- `buildStandardMinterData` / `changeAdminBody` target the **standard governed
  minter** (op `change_admin = 3`). The recommended **stablecoin-contract** has
  a different storage layout and admin ops — for it, pass
  `JETTON_MINTER_DATA_BOC` from its wrapper and use its change-admin body.
- Always confirm the computed address matches what the official wrapper reports
  before funding/deploying.
