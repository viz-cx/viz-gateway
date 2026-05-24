# RUNBOOK — Testnet bring-up (solo, 1-of-1)

Stand up a working bridge with **just your own keys** (1-of-1), then push one
real peg each way. Grow to a validator federation later with no redeploy.

## One architecture note you must internalise first

The two chains authorize disbursements *differently*, and the code reflects this:

- **VIZ release (peg-out): off-chain signatures.** Operators each produce a
  secp256k1 partial signature over the *same* transfer; the coordinator merges
  them and broadcasts one transaction. This path is fully wired
  (`coordinator` → `signer` → `VizJsChain.broadcastRelease`).
- **TON mint (peg-in): on-chain approvals.** `multisig-contract-v2` does **not**
  collect off-chain signatures. The proposer sends a `new_order` to the multisig
  carrying the mint action; each signer approves by sending an `approve` message
  **from the address at `signers[index]`** (or the proposer approves on init);
  at threshold the order executes the mint. For **1-of-1** this collapses to a
  single `new_order` with `approve_on_init=true` from your signer wallet.

Consequence: `TonHttpChain.submitMintOrder` is the integration point that must
create/approve that on-chain order via the official Multisig wrapper — it is the
one piece still to wire (see step 9). Everything else runs today.

## 0. Networks & funds

- **TON testnet** for the multisig + wVIZ jetton. Get test TON from the testnet
  faucet (e.g. @testgiver_ton_bot). Use a testnet `TON_ENDPOINT`
  (`https://testnet.toncenter.com/api/v2/jsonRPC`) and a testnet API key.
- **VIZ**: confirm whether a public VIZ testnet exists. If not, use a dedicated,
  low-balance VIZ **mainnet** account for the gateway (VIZ is ~$0.005, so a
  functional test costs cents). The two custody sides are independent, so
  TON-testnet wVIZ + a low-stakes VIZ account is fine for an end-to-end test.
- Tooling: Node 20+, Docker, and `npx @ton/blueprint` for building the contracts.

## 1. Build the TON bytecode (Blueprint)

```
git clone https://github.com/ton-blockchain/multisig-contract-v2
cd multisig-contract-v2 && npm i && npx blueprint build      # -> Multisig wrapper + code
# export the compiled multisig code cell to a .boc  (build the init data via the wrapper)

git clone https://github.com/ton-blockchain/stablecoin-contract
cd stablecoin-contract && npm i && npx blueprint build       # -> JettonMinter + JettonWallet code
# export the minter + wallet code cells to .boc
```

Build the multisig **init data** with that repo's wrapper (this is the only
correct way to get the storage layout):

```ts
import { Multisig } from "multisig-contract-v2/wrappers/Multisig";
const data = Multisig.configToCell({
  threshold: 1,                       // 1-of-1 bootstrap
  signers: [ <your TON wallet Address> ],
  proposers: [],
  allowArbitrarySeqno: false,
});
require("fs").writeFileSync("multisig.data.boc", data.toBoc());
```

## 2. Deploy the multisig (1 signer = you, threshold 1)

```
MULTISIG_CODE_BOC=./multisig.code.boc \
MULTISIG_DATA_BOC=./multisig.data.boc \
MULTISIG_THRESHOLD=1 MULTISIG_SIGNERS=<your_ton_addr> \
TON_ENDPOINT=https://testnet.toncenter.com/api/v2/jsonRPC TON_API_KEY=... \
npm run deploy:multisig            # dry-run prints the address
# fund that address with test TON, then:
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="...24 words..." npm run deploy:multisig
```

Record the multisig address → `TON_MULTISIG_ADDRESS`.

## 3. Deploy the wVIZ Jetton minter, then hand admin to the multisig

```
JETTON_MINTER_CODE_BOC=./minter.code.boc \
JETTON_WALLET_CODE_BOC=./wallet.code.boc \
JETTON_INITIAL_ADMIN=<your deployer addr> \
WVIZ_SYMBOL=wVIZ WVIZ_DECIMALS=3 \
TON_ENDPOINT=... TON_API_KEY=... \
npm run deploy:minter              # dry-run prints the minter address
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="..." npm run deploy:minter
```

Record the minter address → `TON_JETTON_MINTER_ADDRESS`. Then transfer admin so
only the multisig can mint/burn:

```
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="..." \
MINTER_ADDRESS=<minter> MULTISIG_ADDRESS=<multisig> \
npm run set-minter-admin
```

Get the gateway's own Jetton wallet address (the multisig's wVIZ wallet) for the
minter, and record it → `TON_GATEWAY_JETTON_WALLET` (peg-out deposits go here).

## 4. Create & configure the VIZ gateway account

Create a VIZ account (`viz-gateway`) from an existing account; you hold its
initial master key. Then set its authorities with the setup utility:

```
VIZ_NODE_URL=https://node.viz.cx \
GATEWAY_ACCOUNT=viz-gateway \
ACTIVE_ACCOUNTS=<your_viz_account>   ACTIVE_THRESHOLD=1 \
MASTER_GUARDIANS=on1x,lex,id,denis-skripnik   MASTER_THRESHOLD=3 \
RECOVERY_ACCOUNT=<separate conservative account> \
npm run setup:viz-account          # dry-run prints the authorities + current state
APPLY=1 GATEWAY_MASTER_WIF=<current master key> npm run setup:viz-account
```

After this: `active` = your key (1-of-1), `master` = the 3-of-4 guardian council,
`recovery_account` set. Note: `change_recovery_account` takes effect after VIZ's
owner-recovery delay.

## 5. Configure `.env`

`cp .env.example .env` and fill: `VIZ_NODE_URL`, `VIZ_GATEWAY_ACCOUNT`,
`VIZ_SIGNING_WIF` (your active key), `TON_ENDPOINT`/`TON_API_KEY`,
`TON_MULTISIG_ADDRESS`, `TON_JETTON_MINTER_ADDRESS`, `TON_GATEWAY_JETTON_WALLET`,
`TON_SIGNER_MNEMONIC` (your TON signer wallet), `FEDERATION_N=1`,
`FEDERATION_THRESHOLD=1`, `SIGNER_ENDPOINTS=http://signer:8090`. Keep the fee/cap
defaults (100 VIZ floor, 0.30%, 2,000 VIZ min; $500/$1k/$10k caps).

## 6. Fund the TON gas

Keep the **multisig** funded with test TON so it can pay for mint execution and
recipient jetton-wallet deploys (~0.05–0.1 TON per first-time peg-in).

## 7. Run

```
docker compose up --build
```

This starts watchers + signer + recon + coordinator in one stack (solo). Check
`recon` logs show `locked=… circulating=… status=OK` and `coordinator` logs
`listening … threshold=1-of-1`.

## 8. Test peg-out first (it's the fully-wired path)

You need some wVIZ to send. As multisig admin, mint a little wVIZ to a test
user wallet (one multisig order). Then from that wallet, **send the wVIZ to
`TON_GATEWAY_JETTON_WALLET` with a text comment = a VIZ account name**. Expected:

1. `ton-watcher` detects the `transfer_notification`, after the finality buffer.
2. It POSTs the peg-out action to the coordinator.
3. The coordinator builds the VIZ release proposal, the signer signs (1-of-1),
   and `broadcastRelease` sends the VIZ transfer.
4. The VIZ account receives VIZ. `recon` stays 1:1 (burn the received wVIZ to keep it).

This exercises `ton-watcher → coordinator → signer → VizJsChain.broadcastRelease`
against live chains.

## 9. Test peg-in (wire the on-chain mint order here)

Send **≥ 2,000 VIZ** to `viz-gateway` with the memo set to your **TON address**.
Expected: `viz-watcher` detects the deposit after irreversibility (~14 blocks),
applies the fee/min, and POSTs the peg-in action to the coordinator.

The final step — `submitMintOrder` — is the one piece to finish: it must send a
`new_order` to the multisig that mints `net` wVIZ to the user (and the fee to the
treasury), with `approve_on_init=true` (1-of-1 executes immediately). Wire it
using the `Multisig` wrapper from step 1. Once wired, the user receives wVIZ and
`recon` shows `locked == circulating`.

## 10. Verify & drills

- `RECON_ONCE=1 npm run start:recon` (or the running recon) → `status=OK`, drift 0.
- Pause drill: trip the pause (recon on a forced mismatch, or a manual
  `store.pause()`); confirm watchers log "paused; skipping" and the signer returns
  HTTP 423. Unpause to resume.
- Confirm a below-minimum deposit (< 2,000 VIZ) is logged "below minimum; flag
  for refund" and not minted.

## Known gaps to close during bring-up

- **`submitMintOrder`** — wire the on-chain `new_order`/approve via the Multisig
  wrapper (step 9). This is the only thing between here and a full round-trip.
- **Fee split at mint** — mint `gross` with `net` to the user and `fee` to the
  treasury jetton wallet (keeps 1:1); the quote is already computed by the watcher.
- **Gas-wallet watermark** — auto-pause peg-in when the multisig TON balance is
  too low to mint (peg-out stays up). Not yet implemented.
- **Submit outbox/retry** — a failed coordinator submit currently logs and needs
  manual follow-up; add a persistent outbox before real volume.
