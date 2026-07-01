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

> For the automated end-to-end round-trip harness, see [docs/e2e.md](docs/e2e.md).

## Deployed — TON testnet (1-of-1, 2026-07-01)

Live bring-up instances (recorded in `.env.e2e`; code provenance in
`contracts/ton/boc/PROVENANCE.md`):

| Contract | Address |
|---|---|
| Multisig (1-of-1) | `EQAAT5z3d9RQYAoEMcNbvniJWxnMS5zrriVmCtRWUbTFFRlJ` |
| wVIZ Jetton minter (admin = multisig) | `EQDtadChfr01tTZb3DIgBTww9b4w3Ejxja1VNh5sAx3gKEW7` |
| Gateway jetton wallet (multisig-owned, peg-out deposits) | `EQDcktQd-hXf_s0qaubJoBi2RsSYf_Y9GoW9TbHFM78X0AOa` |
| Signer / deployer WalletV4 | `EQDyPBoVwQLyUGjWdetwoVMdw9-aP0BkyvbWZAdONbfNdKDb` |

Done: multisig deployed → minter deployed → minter admin handed to the multisig
(verified on-chain: `mintable=true`, `adminAddress==multisig`). Next: fund the
multisig gas (step 6) and run a peg-out (step 8).

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
cd multisig-contract-v2 && git checkout 9a4b13d   # pin = our vendored wrappers
npm install --ignore-scripts && npx blueprint build --all    # -> build/Multisig.compiled.json
# the .compiled.json `hex` field IS the code-cell BOC: Buffer.from(hex,"hex") -> multisig.code.boc

git clone https://github.com/ton-blockchain/token-contract
cd token-contract
# blueprint here needs @ton/ton + typescript alongside the pinned @ton/core:
npm install --ignore-scripts --legacy-peer-deps
npm install --ignore-scripts --legacy-peer-deps @ton/ton@13.9.0 @ton/crypto@3.2.0 typescript@5
npx blueprint build --all                                    # -> build/JettonMinter + JettonWallet
# export minter + wallet code cells to .boc (same hex->boc extraction)
```

> **Minter source = `token-contract`, NOT `stablecoin-contract`.** Our code
> (`packages/ton-watcher/src/tonChain.ts`, `contracts/ton/src/{minter,setMinterAdmin}.ts`)
> targets the standard governed minter: `op::mint()=21`, `internal_transfer=0x178d4519`,
> single-step `change_admin` (op 3), storage `total_supply admin content jetton_wallet_code`.
> `token-contract/ft/jetton-minter-discoverable.fc` matches exactly; stablecoin-contract's
> layout (`+transfer_admin`, two-step admin) does not. See `contracts/ton/boc/PROVENANCE.md`.

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
MASTER_GUARDIANS=<guardian-1,guardian-2,...>   MASTER_THRESHOLD=3 \
RECOVERY_ACCOUNT=<separate conservative account> \
npm run setup:viz-account          # dry-run prints the authorities + current state
APPLY=1 GATEWAY_MASTER_WIF=<current master key> npm run setup:viz-account
```

`MASTER_GUARDIANS` has **no default** — set it explicitly to the recovery council
accounts (the setup aborts if unset). After this: `active` = your key (1-of-1),
`master` = the guardian council (e.g. 3-of-4, recovery only), `recovery_account`
set. Note: `change_recovery_account` takes effect after VIZ's owner-recovery delay.

## 5. Configure `.env`

`cp .env.example .env` and fill: `VIZ_NODE_URL`, `VIZ_GATEWAY_ACCOUNT`,
`VIZ_SIGNING_WIF` (your active key), `TON_ENDPOINT`/`TON_API_KEY`,
`TON_MULTISIG_ADDRESS`, `TON_JETTON_MINTER_ADDRESS`, `TON_GATEWAY_JETTON_WALLET`,
`TON_SIGNER_MNEMONIC` (your TON signer wallet), `FEDERATION_N=1`,
`FEDERATION_THRESHOLD=1`, `SIGNER_ENDPOINTS=http://signer:8090`. Keep the fee/cap
defaults (100 VIZ floor, 0.30%, 2,000 VIZ min; $500/$1k/$10k caps).

### F2 — signer independent source validation (env per operator)

Each signer independently re-reads the source event from **its own** nodes before
signing, so `VIZ_NODE_URL` and `SOLANA_RPC_URL` on the signer **must point at the
operator's own RPC, never a coordinator-fed endpoint** — that independence is the whole
security guarantee.

> 🔑 **Operational invariant (not code-enforceable).** Nothing in the gateway can prove a
> signer's node URLs are truly independent of the coordinator — if an operator points
> `VIZ_NODE_URL`/`SOLANA_RPC_URL` at the coordinator's RPC, F2 silently degrades to
> trusting the coordinator. Each operator MUST verify this themselves at deploy time, and
> monitoring should **alert if any signer's node URL resolves to the same host/IP as the
> coordinator** (or a shared upstream). Treat a matching endpoint as a sev-1 misconfig.
>
> Note also: a non-Solana PEG_OUT (TON source validation is not yet implemented) is now
> **refused fail-closed** by the signer, not warned-and-signed. Implement TON source
> re-validation before enabling TON peg-out, or every TON release will (correctly) stall.

For Solana **peg-out**, the signer re-derives the per-account deposit address to confirm
the release target, using a **public** master key (no spend authority):

- The single sweep service still holds the secret `SOLANA_DEPOSIT_MASTER_SEED`.
- Every signer sets `DEPOSIT_MASTER_PUB` — derive it from the seed once and publish it:

  ```bash
  node -e 'console.log(require("./packages/solana-watcher/dist/depositAddress.js").masterPubFromSeed(process.env.SOLANA_DEPOSIT_MASTER_SEED))'
  ```

> ⚠️ **Breaking change (pre-launch):** deposit-address derivation switched from the old
> HMAC scheme to **additive ed25519** (domain `viz-gateway:peg-out:v2`), so every deposit
> address changes. On deploy of this change, **clear the `deposit_addresses` table**
> (re-registered on next lookup) — no migration, this is pre-funds.

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

## How peg-in mint works on Solana

wVIZ on Solana is an SPL Token-2022 mint (3 decimals) whose mint+freeze
authority is an SPL M-of-N multisig (deployed by `npm run deploy:solana`).
Minting is **M ed25519 signatures over one transaction**, collected off-chain —
the same shape as a VIZ release, not TON's on-chain approvals.

The transaction uses a **durable nonce** instead of a recent blockhash, so the
signed bytes never expire while operators sign asynchronously. Two signature
roles share the tx:

- **operator members** — the M multisig signatures = the mint authorization,
  collected via pass-around (`mintAuth`).
- **submitter** — fee payer + nonce authority + ATA-create funder, added last at
  broadcast. The submitter is NOT a multisig member and holds no mint power.

One-time setup (deferred live steps):

1. Deploy the wVIZ mint + SPL multisig: `npm run deploy:solana` (set
   `SOLANA_SIGNERS`, `SOLANA_THRESHOLD`, `DEPLOY_SEND=1`, a funded
   `SOLANA_PAYER_SECRET`).
2. Create a durable nonce account owned by the submitter (nonce authority), and
   set `SOLANA_NONCE_ACCOUNT`, `SOLANA_MULTISIG`, `SOLANA_WVIZ_MINT`.
3. Each operator sets `SOLANA_SIGNER_SECRET` (its own member key); the submitter
   sets `SOLANA_SUBMITTER_SECRET`.

Mint flow per peg-in:

1. Proposer: `SolanaChain.buildMintProposal(action, signerSet)` fetches the nonce
   and pins the exact message (`messageB64`).
2. Each operator validates the proposal (recipient + amount) and signs via
   `approveSolanaMint`, returning `"<memberPubkey>:<sigHex>"`.
3. Submitter: `SolanaChain.submitMint(proposal, mintAuth)` assembles, verifies all
   signatures, and broadcasts.

The cryptographic assembly is verified offline by
`tools/solana-writepath-spike.cjs` (in `npm run verify`). The nonce-fetch,
broadcast, and routing Solana peg-ins through the signer service are deferred to
a manual devnet validation run.

## 10. Verify & drills

- `RECON_ONCE=1 npm run start:recon` (or the running recon) → `status=OK`, drift 0.
- Pause drill: trip the pause (recon on a forced mismatch, or a manual
  `store.pause()`); confirm watchers log "paused; skipping" and the signer returns
  HTTP 423. Unpause to resume.
- Confirm a below-minimum deposit (< 2,000 VIZ) is logged "below minimum; flag
  for refund" and not minted.

## Rotating the operator set

Any current operator can rotate the VIZ `active`/`regular` authority to a new
operator set + threshold — no guardian, no master key. The new set is the
**complete replacement**, given as `op-id=<vizPub>:<tonPub>` entries. All VIZ
partials sign the same TaPoS-bound `account_update`, so the T partials must be
collected and `broadcast` within VIZ's 1-hour window (the tool uses 55min). If the
window lapses, restart from `propose`.

```bash
# 1. A current operator proposes (signs first partial, writes rotation-proposal.json)
VIZ_SIGNING_WIF=<op1-active-wif> npm run rotate -- propose \
  --operators "op-1=<k1>:aa,op-2=<k2>:bb,op-3=<k3>:cc" --threshold 2
# 2. Other operators co-sign the SAME file (validates byte-identity, appends a partial)
VIZ_SIGNING_WIF=<op2-active-wif> npm run rotate -- co-sign rotation-proposal.json
# 3. Once T partials are collected, broadcast (dry-run by default; APPLY=1 to send)
APPLY=1 VIZ_SIGNING_WIF=<op1-active-wif> npm run rotate -- broadcast viz rotation-proposal.json
```

`broadcast viz` re-reads the live `active` authority and aborts if it changed since
`propose` (anti-rollback), then rewrites `federation.json` and writes
`rotation-state.json { vizDone: true }`. Confirm with
`viz.api.getAccounts(["<gateway>"])` that `active_authority.key_auths` equals the new
set — this proves an active-only `account_update` lands with only active-authority
signatures (no master).

> **Verification record — TODO (live testnet).** Everything in the rotation tool
> is verified offline (`tools/rotation-spike.cjs`); the one claim still needing an
> on-chain proof is that VIZ accepts an active-only `account_update` with no master
> signature. Run the 3-command ceremony above on VIZ **testnet** against a gateway
> account whose `active` is a key-set you control, then record here:
> - [ ] date + node URL
> - [ ] broadcast tx id / block num
> - [ ] confirmed `active_authority.key_auths` equals the new set
>       (`viz.api.getAccounts(["<gateway>"])`)

### TON side of a rotation (on-chain, asynchronous)

After `broadcast viz` lands the VIZ side, rotate the TON multisig to the same new
operator set. TON approval is **on-chain**: there is no off-chain signature file —
each current signer sends their own `approve`. Signers are WalletV4 (workchain 0)
addresses derived from each operator's `tonPubkey`.

```bash
# 1. A current signer submits the update order (dry-run, then APPLY=1)
APPLY=1 TON_MULTISIG_ADDRESS=<addr> TON_SIGNER_MNEMONIC="<24 words>" \
  npm run rotate:ton -- submit-ton rotation-proposal.json     # prints ORDER_ADDR
# 2. Each OTHER current signer approves on-chain (validates the order vs the proposal first)
APPLY=1 TON_SIGNER_MNEMONIC="<24 words>" npm run rotate:ton -- approve-ton <ORDER_ADDR>
# 3. Anyone polls both chains; sets tonDone once the multisig signer set changed
TON_MULTISIG_ADDRESS=<addr> npm run rotate:ton -- status
```

Because TON serializes config changes (a pending order is rejected once any update
lands), only one rotation may be in flight at a time. `approve-ton` re-derives the
expected order from the proposal and aborts unless the on-chain order is byte-identical.

> **Verification record — TODO (live testnet).** Run the ceremony on TON testnet and record:
> - [ ] date + endpoint + multisig address
> - [ ] order address + executed=true
> - [ ] `status` shows the multisig signer set == the new operator set

### Solana operator rotation

Prereq (one-time): a dedicated rotation nonce account, authority = the submitter:

```bash
solana create-nonce-account rotation-nonce.json 0.0015 --nonce-authority <submitter>
# set SOLANA_ROTATION_NONCE_ACCOUNT=<that account's pubkey>
```

SPL multisigs are immutable, so rotation creates a NEW multisig and hands the
mint+freeze authority to it (two-phase). Run after `rotate broadcast viz` so the
shared `rotation-proposal.json` already carries the new set (incl. each operator's
Solana pubkey).

1. **Proposer** (also creates the new multisig on-chain):
   ```bash
   APPLY=1 npm run rotate:solana -- propose-solana   # writes rotation-solana.json
   ```
2. **Each current operator** co-signs (validates the new multisig on-chain first):
   ```bash
   npm run rotate:solana -- co-sign-solana rotation-solana.json
   ```
3. **Submitter** broadcasts once `newThreshold` partials are collected:
   ```bash
   APPLY=1 npm run rotate:solana -- broadcast-solana rotation-solana.json
   ```
4. **All operators**: set `SOLANA_MULTISIG=<new address printed above>` and restart
   the gateway. Confirm: `npm run rotate:solana -- status` (read-only). To record
   `solanaDone=true` in `rotation-state.json`, run `status --commit` — plain `status`
   never writes.

The operator spec is `op-1=<vizPub>:<tonPub>[:<solanaPub>]`. The Solana field is
**optional** (a VIZ/TON-only rotation may omit it); `propose-solana` requires every
operator to carry a Solana pubkey and fails if one is missing.

> ⚠️ **Abandon a rotation = advance the nonce.** The handoff is a durable-nonce tx, so a
> set of `M` collected partials stays replayable until `SOLANA_ROTATION_NONCE_ACCOUNT`
> advances (`validateProposal` runs with `skipExpiry`, so there is no time bound). If a
> rotation is abandoned with partials already shared, **rotate/advance the nonce** to
> invalidate those stale partials before starting over:
> ```bash
> solana new-nonce SOLANA_ROTATION_NONCE_ACCOUNT --nonce-authority <submitter>
> ```

> 🧪 **Devnet dry-run first.** The handoff moves real mint authority and the offline
> spike cannot exercise `createMultisig`, the durable-nonce `setAuthority`, partial-merge
> onto a live tx, or the nonce-aware confirmation. Do a full devnet rotation (propose →
> co-sign → broadcast → status) end-to-end before relying on this on mainnet.

## Known gaps to close during bring-up

- **`submitMintOrder`** — wire the on-chain `new_order`/approve via the Multisig
  wrapper (step 9). This is the only thing between here and a full round-trip.
- **Fee split at mint** — mint `gross` with `net` to the user and `fee` to the
  treasury jetton wallet (keeps 1:1); the quote is already computed by the watcher.
- **Gas-wallet watermark** — auto-pause peg-in when the multisig TON balance is
  too low to mint (peg-out stays up). Not yet implemented.
- **Submit outbox/retry** — a failed coordinator submit currently logs and needs
  manual follow-up; add a persistent outbox before real volume.
