# E2E Test Harness

The `tools/e2e/` harness drives a full peg round trip (lock VIZ → mint wVIZ → burn → release VIZ) against live chains. It is intended for **manual dispatch only** — never runs automatically on PR merges.

VIZ is tested on mainnet with a dedicated low-stakes account (VIZ ≈ $0.005; a round trip costs cents). TON wVIZ is tested on TON testnet. **Never use a TVL-holding production gateway key.**

---

## 1. One-time provisioning

Run these once; reuse the resulting accounts every subsequent run.

### VIZ accounts

```bash
# Create the test account (the one that locks VIZ) and fund it with ~50 VIZ
# Use the existing setup:viz-account script against your test credentials,
# or use any VIZ wallet. The account needs no special gateway authorities.

# Create the release recipient account (receives released VIZ on peg-out)
# A plain VIZ account is fine. Fund with a few VIZ so it exists on chain.
```

Record:
- `E2E_VIZ_TEST_ACCOUNT` = name of the test account (locks VIZ)
- `E2E_VIZ_RECIPIENT` = name of the release recipient account
- `E2E_VIZ_GATEWAY_ACCOUNT` = the existing gateway account name (same as production)

### TON testnet contracts

```bash
# Deploy the multisig + jetton minter (reuse existing deploy scripts):
TON_ENDPOINT=https://testnet.toncenter.com/api/v2/jsonRPC TON_API_KEY=<key> \
  npm run deploy:multisig

TON_ENDPOINT=... npm run deploy:minter
TON_ENDPOINT=... npm run set-minter-admin

# Fund the gateway jetton wallet and the burn wallet from @testgiver_ton_bot
# (send test TON to both addresses on TON testnet)
```

Record:
- `E2E_TON_GATEWAY_JETTON_WALLET` = gateway's jetton wallet address
- `E2E_TON_GATEWAY_OWNER` = gateway's owner address (the owner of the jetton wallet above)
- `E2E_TON_JETTON_MINTER_ADDRESS` = wVIZ jetton minter address

### Burn wallet (peg-out submitter)

Generate a fresh TON wallet mnemonic for testnet use only:

```bash
node -e "
const { mnemonicNew } = require('@ton/crypto');
mnemonicNew(24).then(m => console.log(m.join(' ')));
"
```

Derive its address:

```bash
node -e "
const { WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const mnemonic = '<your 24 words>'.split(' ');
mnemonicToPrivateKey(mnemonic).then(k => {
  const w = WalletContractV4.create({ workchain: 0, publicKey: k.publicKey });
  console.log(w.address.toString());
});
"
```

Fund it with test TON from @testgiver\_ton\_bot, and provision it with a wVIZ jetton wallet by sending a tiny wVIZ transfer to it from any funded address.

Record:
- `E2E_TON_BURN_MNEMONIC` = the 24-word mnemonic (secret — CI secret only)
- `E2E_TON_BURN_OWNER` = the derived wallet address (public, used as the wVIZ mint recipient)

---

## 2. Secret list

Set these as encrypted Actions secrets in the repo settings, or in a local `.env` for local runs. **All are dedicated low-stakes accounts only.**

| Secret | Description |
|---|---|
| `E2E_VIZ_NODE_URL` | VIZ node URL, e.g. `https://node.viz.cx` |
| `E2E_VIZ_TEST_WIF` | WIF private key for the VIZ test account (active authority) |
| `E2E_VIZ_TEST_ACCOUNT` | VIZ test account name (locks VIZ on peg-in) |
| `E2E_VIZ_GATEWAY_ACCOUNT` | Gateway VIZ account name |
| `E2E_VIZ_RECIPIENT` | VIZ release recipient account name |
| `E2E_VIZ_MIN_BALANCE_MILLI_VIZ` | Minimum test account balance floor (e.g. `5000000` = 5 VIZ) |
| `E2E_TON_ENDPOINT` | TON testnet endpoint URL |
| `E2E_TON_API_KEY` | TON API key for the testnet endpoint |
| `E2E_TON_GATEWAY_JETTON_WALLET` | Gateway's wVIZ jetton wallet address |
| `E2E_TON_GATEWAY_OWNER` | Gateway's owner address (jetton transfer destination) |
| `E2E_TON_JETTON_MINTER_ADDRESS` | wVIZ jetton minter address |
| `E2E_TON_BURN_MNEMONIC` | Burn wallet 24-word mnemonic **(most sensitive TON secret)** |
| `E2E_TON_BURN_OWNER` | Burn wallet address (public, used as peg-in recipient on TON) |
| `E2E_TON_MIN_GAS_NANO` | Minimum gas reserve in nanoTON (e.g. `100000000` = 0.1 TON) |

---

## 3. Local run

```bash
# Copy and fill in the provisioned secrets
cp .env.example .env
# Add all E2E_* vars from the secret list above

npm run e2e:ton
```

On success: `[e2e] ROUND TRIP OK: released <net> mVIZ to <recipient>` and exits 0.

On failure: inspect per-service logs in `tools/e2e/logs/<runId>/`:
- `viz-watcher.log`
- `ton-watcher.log`
- `signer.log`
- `coordinator.log`
- `dispatcher.log`

---

## 4. Dispatch run (GitHub Actions)

1. Go to **Actions** → **E2E (live)** → **Run workflow**.
2. Pick `chain: ton` (Solana is Phase 2).
3. The job runs on `ubuntu-latest`, builds from source, executes the round trip, and uploads `e2e-logs-ton` as an artifact (always, even on failure).

The `concurrency: e2e-live` group ensures two runs can't race on the same test accounts.

---

## 5. Top-up thresholds

The harness fails fast on preflight if either account is underfunded:

- **VIZ test account**: needs at least `E2E_VIZ_MIN_BALANCE_MILLI_VIZ` milli-VIZ. Default: 5,000,000 (5 VIZ). Top up at any VIZ exchange or from another account. A round trip consumes ~20 VIZ principal + the fee (~10 VIZ floor); the principal returns, only the fee stays in `fees.gate`.
- **TON burn wallet**: needs test TON for gas. Default floor: `E2E_TON_MIN_GAS_NANO` = 100,000,000 nanoTON (0.1 TON). Top up from @testgiver\_ton\_bot on TON testnet. The harness does not yet check this automatically; the preflight will fail at the TON `submitBurn` step if the wallet has insufficient gas.

If preflight fails with `top up <account>`, the error message states the account name and current/required balance.
