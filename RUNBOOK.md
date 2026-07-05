# RUNBOOK — Testnet bring-up (solo, 1-of-1)

Stand up a working bridge with **just your own keys** (1-of-1), then push one
real peg each way. Grow to a validator federation later with no redeploy.

> **Naming note:** internally the gateway identifies this chain as **GRAM** (env vars,
> npm scripts, config keys). Externally the chain is still the **TON network** — the
> `@ton/…` SDK packages, toncenter endpoints, and `contracts/ton/` deploy scripts are
> unchanged.

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

Consequence (Phase B, DONE): the coordinator is **keyless on TON**. It only
describes the mint order (`GramMintBroadcaster.buildProposal` → real order-cell
hash + deterministic order address); each operator's signer performs the actual
on-chain propose/approve **from its own wallet** (`KeyedSigner.approveGramMint` →
`GramApprover`, `packages/gram-watcher/src/gramApprove.ts`). `broadcast` submits
nothing — it polls `orderExecuted`. This is what makes TON a genuine M-of-N: the
component that builds the order cannot itself move funds. Proven offline against
the real vendored contracts by `tools/gram-onchain-approval-spike.cjs` (3-of-5, in
`npm run verify`); live 3-of-5 testnet checklist in §9b.

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
  faucet (e.g. @testgiver_ton_bot). Use a testnet `GRAM_ENDPOINT`
  (`https://testnet.toncenter.com/api/v2/jsonRPC`) and a testnet API key.
- **VIZ**: confirm whether a public VIZ testnet exists. If not, use dedicated,
  low-balance VIZ **mainnet** accounts for the gateway (VIZ is ~$0.005, so a
  functional test costs cents). The two custody sides are independent, so
  TON-testnet wVIZ + low-stakes VIZ accounts is fine for an end-to-end test.
- **Per-network VIZ backing accounts (greenfield):** each external chain gets its
  own VIZ account so VIZ locked on its behalf is ring-fenced:
  - `gram.gate` — receives VIZ from users bridging to GRAM/TON; releases VIZ on
    GRAM peg-outs. Set `VIZ_GATEWAY_ACCOUNT_GRAM=gram.gate`.
  - `solana.gate` — same for Solana. Set `VIZ_GATEWAY_ACCOUNT_SOLANA=solana.gate`.
  - `fees.gate` — unchanged; receives fee sweeps from both chains.
  - No balance migration: greenfield bring-up starts with all accounts at zero.
    The accounts are independent, so neither chain's backing can offset the other's.
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
> (`packages/gram-watcher/src/gramChain.ts`, `contracts/ton/src/{minter,setMinterAdmin}.ts`)
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
GRAM_ENDPOINT=https://testnet.toncenter.com/api/v2/jsonRPC GRAM_API_KEY=... \
npm run deploy:multisig            # dry-run prints the address
# fund that address with test TON, then:
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="...24 words..." npm run deploy:multisig
```

Record the multisig address → `GRAM_MULTISIG_ADDRESS`.

## 3. Deploy the wVIZ Jetton minter, then hand admin to the multisig

```
JETTON_MINTER_CODE_BOC=./minter.code.boc \
JETTON_WALLET_CODE_BOC=./wallet.code.boc \
JETTON_INITIAL_ADMIN=<your deployer addr> \
WVIZ_SYMBOL=wVIZ WVIZ_DECIMALS=3 \
GRAM_ENDPOINT=... GRAM_API_KEY=... \
npm run deploy:minter              # dry-run prints the minter address
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="..." npm run deploy:minter
```

Record the minter address → `GRAM_JETTON_MINTER_ADDRESS`. Then transfer admin so
only the multisig can mint/burn:

```
DEPLOY_SEND=1 DEPLOYER_MNEMONIC="..." \
MINTER_ADDRESS=<minter> MULTISIG_ADDRESS=<multisig> \
npm run set-minter-admin
```

Get the gateway's own Jetton wallet address (the multisig's wVIZ wallet) for the
minter, and record it → `GRAM_GATEWAY_JETTON_WALLET` (peg-out deposits go here).

## 4. Create & configure the VIZ backing accounts

Create **two** VIZ accounts — one per external chain — from an existing account;
you hold their initial master keys. Then set each account's authorities with the
setup utility:

```
# gram.gate (GRAM/TON backing account)
VIZ_NODE_URL=https://node.viz.cx \
GATEWAY_ACCOUNT=gram.gate \
ACTIVE_ACCOUNTS=<your_viz_account>   ACTIVE_THRESHOLD=1 \
MASTER_GUARDIANS=<guardian-1,guardian-2,...>   MASTER_THRESHOLD=3 \
RECOVERY_ACCOUNT=<separate conservative account> \
npm run setup:viz-account
APPLY=1 GATEWAY_MASTER_WIF=<current master key> npm run setup:viz-account

# solana.gate (Solana backing account)
VIZ_NODE_URL=https://node.viz.cx \
GATEWAY_ACCOUNT=solana.gate \
ACTIVE_ACCOUNTS=<your_viz_account>   ACTIVE_THRESHOLD=1 \
MASTER_GUARDIANS=<guardian-1,guardian-2,...>   MASTER_THRESHOLD=3 \
RECOVERY_ACCOUNT=<separate conservative account> \
npm run setup:viz-account
APPLY=1 GATEWAY_MASTER_WIF=<current master key> npm run setup:viz-account
```

`MASTER_GUARDIANS` has **no default** — set it explicitly to the recovery council
accounts (the setup aborts if unset). After this: `active` = your key (1-of-1),
`master` = the guardian council (e.g. 3-of-4, recovery only), `recovery_account`
set. Note: `change_recovery_account` takes effect after VIZ's owner-recovery delay.

> **Injectivity invariant:** `gram.gate` and `solana.gate` MUST be distinct VIZ
> accounts. Sharing the same account would break the per-chain isolation guarantee —
> `GatewayAccounts` enforces this at construction and will refuse to start.

## 5. Configure `.env`

`cp .env.example .env` and fill: `VIZ_NODE_URL`,
`VIZ_GATEWAY_ACCOUNT_GRAM=gram.gate`, `VIZ_GATEWAY_ACCOUNT_SOLANA=solana.gate`,
`VIZ_SIGNING_WIF` (your active key — must be authorised on BOTH backing accounts),
`GRAM_ENDPOINT`/`GRAM_API_KEY`, `GRAM_MULTISIG_ADDRESS`,
`GRAM_JETTON_MINTER_ADDRESS`, `GRAM_GATEWAY_JETTON_WALLET`,
`GRAM_SIGNER_MNEMONIC` (your TON signer wallet), `FEDERATION_N=1`,
`FEDERATION_THRESHOLD=1`, `SIGNER_ENDPOINTS=http://signer:8090`. Keep the fee/cap
defaults (100 VIZ floor, 0.30%, 2,000 VIZ min; $500/$1k/$10k caps).

> **`VIZ_GATEWAY_ACCOUNT` is removed.** Replace it with the two per-chain variables
> above. Both must be set; the gateway refuses to start with either missing or empty.
> `fees.gate` (`FEES_GATE_ACCOUNT`) is unchanged — fee sweeps from all chains land there.

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
> Note also: PEG_OUT is dispatched by source-id **shape**, not the coordinator-supplied
> `remoteChain` — a `:fee`/`:refund` suffix → gateway-internal re-derivation (below), a
> Solana signature (base58) → Solana re-read, a 64-hex burn tx hash → TON re-read, anything
> else → refused fail-closed. TON peg-out re-read is now implemented (`GramHttpChain.getBurn`
> bounded-scans the gateway jetton wallet on the operator's own node); the signer needs
> `GRAM_ENDPOINT` / `GRAM_GATEWAY_JETTON_WALLET` pointed at that node.
>
> **Gateway-internal releases (FEE_SWEEP / REFUND)** have no remote source; the signer
> re-derives them from the PEG_IN they settle (re-read from its OWN VIZ node). A FEE_SWEEP
> may only release to the operator's OWN `fees.gate` for an amount within the independently
> derived fee band `[base, base + activationSurcharge]`; a REFUND may only return the GROSS
> deposit to its original sender. Both bind the child digest to the parent PEG_IN digest.

For Solana **peg-out**, every signer independently re-derives the deposit address as a
pure PDA — no secret required:

```bash
node -e 'console.log(require("./packages/solana-watcher/dist/depositAddress.js").depositAddress(process.env.SOLANA_DEPOSIT_PROGRAM_ID, "alice"))'
```

Set `SOLANA_DEPOSIT_PROGRAM_ID` to the deployed gateway-deposit program ID
(`MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1` on devnet/mainnet after deploy).
No seed, no `DEPOSIT_MASTER_PUB`. F2 source validation is a pure PDA re-derivation:
`depositAddress(programId, vizAccount)` must equal the burn source address, deterministically.

> The burn-only program holds no private key. All funds arriving at a PDA can only be
> burned by the `burn_deposit` instruction — there is no transfer path. Upgrade authority
> must be set to the M-of-N multisig (see `contracts/solana/PROVENANCE.md`).

### Cutover runbook: seed-based addresses → PDA addresses

This cutover is required when migrating from the old additive-ed25519 scheme to PDA custody.
Execute in order, with the gateway **paused** between steps 2 and 5.

1. **Deploy** `gateway_deposit` to devnet then mainnet; verify the program ID matches
   `MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1`; set the upgrade authority to the M-of-N
   multisig; record the program ID and provenance in `contracts/solana/PROVENANCE.md`.
2. **Reconfigure** lookup, scanner, and all signers: set `SOLANA_DEPOSIT_PROGRAM_ID`;
   remove `SOLANA_DEPOSIT_MASTER_SEED` and `DEPOSIT_MASTER_PUB` from every host.
3. **Freeze issuance** of old additive deposit addresses: deploy the new lookup service
   (which issues PDA addresses only and rejects new additive-scheme registrations).
4. **Drain** any funds still sitting at old additive deposit ATAs: run a **final** pass of
   the retiring seed-based sweeper to detect and release those peg-outs normally before
   decommissioning it.
5. **Clear** the `deposit_addresses` table; let PDA addresses be re-issued on demand
   (the lookup service re-derives them deterministically from `programId` + VIZ account).
6. **Destroy** `SOLANA_DEPOSIT_MASTER_SEED` from all secret stores (vaults, CI, operator
   machines). This key has no further purpose once step 4 is complete.

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

## 8. Test peg-out

> ✅ **TON peg-out PROVEN end-to-end (2026-07-01).** A live testnet round-trip detected the
> burn, the signer independently re-read it (`GramHttpChain.getBurn`), validated the release
> against its own node view, and broadcast the VIZ release (1-of-1). Two fixes were required
> to get here: (1) the watcher now parses the gateway jetton wallet's real inbound message,
> TEP-74 `internal_transfer` (0x178d4519), not `transfer_notification`; (2) F2 source
> re-read. The signer's `GRAM_ENDPOINT` / `GRAM_GATEWAY_JETTON_WALLET` **must** point at the
> operator's own node (the F2 independence invariant).
>
> ✅ **Persistent store (default since 2026-07-01):** the harness now points every run at a
> stable `sqlite:./data/e2e.sqlite`, so idempotency memory survives across runs — a peg-out
> burn already released on a prior run is **not** re-released when it's still inside the
> watcher's `GRAM_MAX_TRANSACTIONS` scan window (matches production). Set `E2E_FRESH_STORE=1`
> to opt back into a per-run store keyed by `runId` (a clean idempotency slate; the old
> behaviour). Note: with the persistent store, re-running the *same* round-trip re-detects the
> prior burn as already-processed — use a fresh burn (each run mints a unique amount) or
> `E2E_FRESH_STORE=1` when you want the full peg-out leg to fire again.

You need some wVIZ to send. As multisig admin, mint a little wVIZ to a test
user wallet (one multisig order). Then from that wallet, **send the wVIZ to
`GRAM_GATEWAY_JETTON_WALLET` with a text comment = a VIZ account name**. Expected:

1. `gram-watcher` detects the `transfer_notification`, after the finality buffer.
2. It POSTs the peg-out action to the coordinator.
3. The coordinator builds the VIZ release proposal, the signer signs (1-of-1),
   and `broadcastRelease` sends the VIZ transfer.
4. The VIZ account receives VIZ. `recon` stays 1:1 (burn the received wVIZ to keep it).

This exercises `gram-watcher → coordinator → signer → VizJsChain.broadcastRelease`
against live chains.

## 9. Test peg-in (wire the on-chain mint order here)

Send **≥ 2,000 VIZ** to `viz-gateway` with the memo set to your **TON address**.
Expected: `viz-watcher` detects the deposit after irreversibility (~14 blocks),
applies the fee/min, and POSTs the peg-in action to the coordinator.

The peg-in mint is authorized by **on-chain multisig approvals** (Phase B): the
designated proposer's signer sends `new_order` (`approve_on_init=true`) and each
other operator's signer sends `approve` from its own wallet; at threshold the
order executes and mints `net` wVIZ to the user. For **1-of-1** this collapses to
a single `new_order` — **PROVEN end-to-end on TON testnet 2026-07-01**. The
multi-operator on-chain routing is proven offline (3-of-5) by
`tools/gram-onchain-approval-spike.cjs`; live 3-of-5 checklist in §9b. The fee-split
mint (fee → treasury) is still a gap (see below).

## 9b. Live 3-of-5 TON peg-in proof (real M-of-N, on-chain approvals)

Proves the Phase B trust boundary on testnet: five independent operator wallets,
a keyless coordinator, and a mint that only lands once 3 distinct operators
approve on-chain. Prereqs: `contracts/ton` built; five funded TON wallets.

0. **Generate the 5 operator wallets + 3-of-5 init data.** `GEN=1 FED_N=5
   MULTISIG_THRESHOLD=3 MULTISIG_CODE_BOC=contracts/ton/boc/multisig.code.boc
   npm run gen:multisig-data` prints 5 fresh mnemonics (save to gitignored
   `docs/federation-ton-keys.md`) + the ordered signer addresses and writes
   `contracts/ton/boc/multisig-3of5.data.boc`. Re-run without `GEN=1` (with the
   saved `FED_OP<i>_GRAM_MNEMONIC` in env) to rebuild the same data cell.
1. **Deploy a fresh 3-of-5 multisig** with those five operator wallet addresses as
   signers (order matters — it fixes each operator's `signers[index]`):
   `DEPLOY_SEND=1 MULTISIG_DATA_BOC=contracts/ton/boc/multisig-3of5.data.boc … npm
   run deploy:multisig`. Deploy the minter and hand it the wVIZ minter admin.
   Record → `GRAM_MULTISIG_ADDRESS`, `GRAM_JETTON_MINTER_ADDRESS`.
2. **Run five signer processes**, one per operator, each with its OWN
   `GRAM_SIGNER_MNEMONIC` (its wallet key) — wired via `FED_OP<i>_GRAM_MNEMONIC` in
   the harness — its own `GRAM_ENDPOINT`, and the shared `GRAM_MULTISIG_ADDRESS` +
   `GRAM_JETTON_MINTER_ADDRESS`. Set `FED_N=5`, `FED_THRESHOLD=3`. The signer refuses
   a TON peg-in unless its `GramApprover` is configured (minter + multisig + mnemonic).
3. **Run the coordinator with NO `GRAM_SIGNER_MNEMONIC`** (it is keyless on TON and
   ignores it if set). It designates the **first** federation operator as proposer;
   the harness orders `SIGNER_ENDPOINTS` op-1-first automatically. Driver:
   `npm run e2e:federation:gram:live` runs criteria 1-3; criterion 4 (rotation) is
   gated on `FED_ROTATION_MODE=live` after the rotation ceremony (step 7).
4. **Drive a peg-in** (send ≥ min VIZ to `viz-gateway` with the memo = a TON
   address). Expected: proposer's signer sends `new_order` (self-approve = 1/3);
   the next two signers each send `approve` (2/3, then 3/3 → executes). The
   coordinator's `broadcast` polls `orderExecuted` and returns the order address.
   Confirm wVIZ supply increased by exactly `net`.
5. **Under-threshold proof:** stop 3 of the 5 signers, drive another peg-in;
   only ≤2 approvals land, the order never executes, and no wVIZ is minted.
6. **Crash-window re-proof:** kill the coordinator mid-approval (after `new_order`,
   before threshold), restart, re-drive. The proposer's signer finds its order
   already exists (no second `new_order`); the remaining approvals complete the
   SAME order. Supply increases by `net` exactly once (no double-mint).
7. **Rotation proof:** rotate the multisig signer set (drop an old operator); the
   dropped operator's `approve` is rejected on-chain (err 106 `unauthorized_sign`),
   while the new set reaches threshold. Automated in the driver (`tools/e2e/gram-rotation.ts`),
   opt-in via `FED_ROTATION_MODE=live` and run **last** — it PERMANENTLY rotates the
   multisig (3-of-5 → 3-of-4), so re-running the suite needs a fresh 3-of-5 deploy
   (step 0-1). Left unset, criterion 4 is skipped and criteria 1-3 still prove out.
   To prove ONLY criterion 4 against an already-proven multisig (skip the stack,
   VIZ preflight, and re-mints), add `FED_ROTATION_ONLY=1`. Criterion 4 needs
   **threshold+1** funded operators — the dropped operator must itself send the
   `approve` that gets rejected on-chain.

Exit criteria: threshold mint by independent wallets ✔, under-threshold no-mint ✔,
crash-window single-mint ✔, rotation rejects old signers ✔.

### Verification record (2026-07-04 / 2026-07-05) — ALL 4 criteria PROVEN live

Run `e2e-1783094535761-49bmor` on TON testnet, driver `npm run
e2e:federation:gram:live` (with `.env.e2e` sourced + `E2E_FRESH_STORE=1`). Real
3-of-5, keyless coordinator, each operator approving from its OWN wallet.

- **Multisig (3-of-5):** `EQCuW98IIpl9tbqnd5c4mGDf1BJahHutqAHoGEPhcR5swo_7`
- **wVIZ jetton minter (admin = multisig):** `EQDCepBYzTOL9SmbM5OpBqyd0VU1VL6JQaJUWZzJXx36VW7o`
- **Signers:** op-1 proposer `EQDyPBoV…` (funded ~2 TON), op-2 `EQBUJb4e…`, op-3
  `EQBK27uc…`; op-4/op-5 valid signers but intentionally unfunded (abstain).
- **① Threshold mint:** peg-in lock `f893ed54…`, order
  `EQDKXNgi-gdhBwXToU4_6mAlv9Ni2CJxDLsqN8v6k6755OyR`, 3/3 approvals → wVIZ **+15367**,
  multisig order seqno 5→6. ✔
- **② Under-threshold:** peg-in lock `8797401e…` with 3 of 5 signers down; order
  never reached 3 approvals → **refunded** (delivery window exhausted), wVIZ
  unchanged. ✔
- **③ Crash-window:** peg-in lock `0e113cb6…`, order
  `EQCUqDo76hItWHMacEDDv0f5JfB6CSOz3UAjpv1-xHdm3OvW`; stack crashed after the order
  landed, relaunched → recovery completed the SAME order (no second `new_order`),
  wVIZ **+15090 once**, seqno stable at 8 (no double-mint). ✔
- **④ Rotation (2026-07-05, run `e2e-1783180883396-flwrzw`, standalone via
  `FED_ROTATION_ONLY=1 FED_ROTATION_MODE=live`):** after funding op-4 to 2 TON,
  op-2 (proposer) proposed dropping op-4; op-1 + op-3 approved → multisig adopted
  the rotated **3-of-4** set (op-4 removed). Rotation order
  `EQD3xXJ5PFG2uY6sRLgSc3viwFAUv4DStib0ru15vDxH6zJn`. On a fresh test order
  `EQCnOKiqjPHgFF0HDqqaKhYa3RBGJzjKVW6JQGGf6NxQb4ad` the dropped op-4's `approve`
  was **rejected on-chain — exit 106 `unauthorized_sign` confirmed** (approvals held
  at 1, never counted); the retained 3-of-4 (op-2 + op-1 + op-3) then reached
  threshold and executed. ✔ **NOTE:** the multisig above is now permanently
  **3-of-4** — re-running criteria 1-3 needs a fresh 3-of-5 deploy (step 0-1).

Fixes this run made the live path work (all on `fix/9b-ton-live-driver`): the
proposer needs ~1 TON/order (`GRAM_ORDER_VALUE_NANO`, lowered to 0.3 TON for the
run); the GramApprover order-wait was 60s (too tight for testnet →
`GRAM_APPROVE_MAX_WAIT_MS`, 150s); the dispatcher refunded landing mints at its 3-min
window (`DISPATCHER_WINDOW_MS`, 8 min for c1/c3; a short window for c2 so its
under-threshold peg-in refunds terminally before c3); and the coordinator now
surfaces signer error bodies (was a bare HTTP status).

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
`tools/solana-writepath-spike.cjs` (in `npm run verify`). The two live steps —
the durable-**nonce fetch** and the on-chain **broadcast** — are exercised by
`tools/solana-devnet-proof.cjs`, which drives the real `SolanaChain` +
`KeyedSigner.approveSolanaMint` against a cluster (F2 source validation disabled
there: this proof targets the write path, not the F2 re-read).

To re-run against a fresh local cluster:

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana-test-validator --reset --quiet &            # local cluster
S=/tmp/viz-solana-proof; mkdir -p $S
for n in payer submitter opA opB recipient nonce; do \
  solana-keygen new --no-bip39-passphrase --silent -o $S/$n.json --force; done
solana -u http://127.0.0.1:8899 airdrop 100 $S/payer.json
solana -u http://127.0.0.1:8899 airdrop 100 $S/submitter.json
# deploy the 2-of-2 mint
SOLANA_RPC_URL=http://127.0.0.1:8899 DEPLOY_SEND=1 SOLANA_THRESHOLD=2 \
  SOLANA_PAYER_SECRET="$(cat $S/payer.json)" \
  SOLANA_SIGNERS="$(solana-keygen pubkey $S/opA.json),$(solana-keygen pubkey $S/opB.json)" \
  npm run deploy:solana                            # prints MINT + MULTISIG
# durable nonce account, authority = submitter
solana -u http://127.0.0.1:8899 -k $S/submitter.json create-nonce-account $S/nonce.json 0.01 \
  --nonce-authority "$(solana-keygen pubkey $S/submitter.json)"
# round-trip mint (fill MINT/MULTISIG from the deploy output)
SOLANA_RPC_URL=http://127.0.0.1:8899 PROOF_DIR=$S \
  SOLANA_WVIZ_MINT=<mint> SOLANA_MULTISIG=<multisig> \
  SOLANA_NONCE_ACCOUNT="$(solana-keygen pubkey $S/nonce.json)" \
  node tools/solana-devnet-proof.cjs
```

> **Verification record — PROVEN (local cluster, 2026-07-01).**
> Agave `solana-test-validator` 4.0.2, RPC `http://127.0.0.1:8899`.
> - wVIZ mint `EWB6z5sRCCsj5rQLwxwznT7PN3gY7dKzgA8YwQoRhPXg` (Token-2022, 3 dec),
>   mint+freeze authority = SPL multisig `EcmP4QR8PGD2E8UGgUzGFXgStcbZmnYcKqwxd9ckdpd6` (**2-of-2**).
> - durable nonce account `DKEXAWAJnn5qgAiYeTRxtxwAJfS8RrdYVhvchyPVq3gC`, authority = submitter.
> - live round-trip: nonce fetched → 2 operator partials merged into one durable-nonce
>   tx → broadcast + confirmed. Clean run tx
>   `dcuxDyCWCJT7LV5PHC97j56jw3pKd3rpaYY32Yo14CkhhqVDcXGeiKLHWByEoeqRZnAwL1AUY9A9jb9KBGnferS`;
>   recipient wVIZ ATA `0 → 1048237` (= NET; GROSS 1068237, fee 20000, incl. activation
>   surcharge since the ATA was created by the mint). `mintByActionId` located the tx by
>   its SPL-Memo action-id marker.
> - Public devnet faucet is rate-limited (per the rotation dry-run); a local
>   `solana-test-validator` exercises identical program paths (Token-2022 + SPL multisig).

## How peg-out burn works on Solana

Each VIZ account is mapped to a **program-derived deposit address** (PDA) under the
`gateway_deposit` program. Users send wVIZ directly to that PDA's ATA. The scanner
calls `burn_deposit` to burn the tokens in-place; there is no transfer path.

PDA derivation: `["deposit", utf8(vizAccount)]` under `programId`. Re-derivation is
deterministic and requires no secret — every signer independently verifies the burn
source is the correct PDA for the claimed VIZ account.

Peg-out flow per deposit:

1. `solana-watcher` detects a wVIZ balance at the deposit ATA for a known VIZ account.
2. It posts the peg-out action to the coordinator (amount = ATA balance).
3. Each signer independently re-derives `depositAddress(programId, vizAccount)` and
   confirms it equals the reported burn source (F2 = pure PDA re-derivation, no secret).
4. `SolanaChain.burnFromDeposit` calls `burn_deposit` on-chain, burning the tokens.
5. The VIZ release is broadcast once `M` signers have approved.

To re-run the peg-out proof against a fresh local cluster:

```bash
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana-test-validator -r &
sleep 5
node tools/solana-pegout-proof.cjs
kill %1
```

The script deploys `gateway_deposit`, creates a Token-2022 wVIZ mint, mints to the
deposit PDA ATA, calls `burn_deposit`, and asserts balance and supply dropped by the
burned amount.

> **Verification record — PROVEN (local cluster, 2026-07-02).**
> Agave `solana-test-validator` 3.1.10, RPC `http://127.0.0.1:8899`.
> - [x] gateway-deposit program `MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1` deployed from `.so`
> - [x] wVIZ mint `2LTnfuwiLAJfChKWUKxPTjpZezBjJH4eo9MazkTxEA9E` (Token-2022, 3 dec)
> - [x] deposit PDA for "alice": `GEo4u7eJaj8ZdZGtjwN1Vc2UaaiVJoafoiyMWM6wgKNm`
> - [x] minted 5 000 000 to deposit ATA; burned 3 000 000 via `burn_deposit`
> - [x] balance `5000000 → 2000000` (delta −3 000 000); supply identical
> - [x] burn sig `5mShvpRPocWWfe14JYwC5hiK5YUN5xXeUth1CBm72bhUBUEiojV8ja7qTuFLZxzXcsYhgVTFT58qYqF4dvL7DUuU`

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

> **Verification record — ✅ PROVEN (VIZ mainnet, 2026-07-01).** The one claim needing
> an on-chain proof — that VIZ accepts an active-only `account_update` (rewrites
> `active`+`regular`, no `master` field) signed by **only** the active authority — is
> confirmed. Round-trip on gateway account `tester4` via `npm run rotate` (`node.viz.cx`),
> `master` (`VIZ7Mh5…`) untouched throughout and never signed:
> - [x] date + node URL: 2026-07-01, `https://node.viz.cx`
> - [x] forward tx (active→throwaway proof key): `cd5ae81759ad6d9893fbf8af5415c1f8abb05e20`
> - [x] confirmed `active_authority.key_auths == [[VIZ5dPcTxWrWN53Q…proof,1]]`, `master` unchanged
> - [x] restore tx (active→original, signed by the proof key): `936770bcb59daa41fd99d311a3a8ec1e4f776fa4`
> - [x] regular-authority exact restore tx: `1171cee260f3b806d7d4988c0314dca08e3d52ec`
>       (`tester4` ended byte-identical to pre-proof: active/regular/master/memo_key)
> Offline coverage remains in `tools/rotation-spike.cjs`.

### GRAM chain side of a rotation (on-chain, asynchronous)

After `broadcast viz` lands the VIZ side, rotate the TON multisig to the same new
operator set. TON approval is **on-chain**: there is no off-chain signature file —
each current signer sends their own `approve`. Signers are WalletV4 (workchain 0)
addresses derived from each operator's `tonPubkey`.

```bash
# 1. A current signer submits the update order (dry-run, then APPLY=1)
APPLY=1 GRAM_MULTISIG_ADDRESS=<addr> GRAM_SIGNER_MNEMONIC="<24 words>" \
  npm run rotate:gram -- submit-gram rotation-proposal.json     # prints ORDER_ADDR
# 2. Each OTHER current signer approves on-chain (validates the order vs the proposal first)
APPLY=1 GRAM_SIGNER_MNEMONIC="<24 words>" npm run rotate:gram -- approve-gram <ORDER_ADDR>
# 3. Anyone polls both chains; sets tonDone once the multisig signer set changed
GRAM_MULTISIG_ADDRESS=<addr> npm run rotate:gram -- status
```

Because TON serializes config changes (a pending order is rejected once any update
lands), only one rotation may be in flight at a time. `approve-gram` re-derives the
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

- **N-of-M federation (VIZ peg-out)** — ✅ PROVEN live 2026-07-02. A real 2-of-3 VIZ
  peg-out completed through 3 independent signer processes over HTTP fan-out. `tester4`
  active authority upgraded to 2-of-3 on VIZ mainnet (`tools/federation-authority-setup.cjs`);
  topology + fault-matrix (under-threshold stall, process-kill isolation) proven via
  `npm run e2e:federation`; live round-trip (solo TON peg-in → 2-of-3 VIZ release) proven
  via `npm run e2e:federation:live`. Operator keys in `docs/federation-keys.md` (gitignored).
- **TON on-chain M-of-N approval routing (Phase B)** — ✅ WIRED + offline-proven
  3-of-5. Coordinator is keyless on TON; operators propose/approve from their own
  wallets (`GramApprover`); `broadcast` polls `orderExecuted`. Proven against the real
  vendored contracts in `tools/gram-onchain-approval-spike.cjs` (`npm run verify`).
  Live 3-of-5 testnet proof: checklist in §9b (deferred operational step). 1-of-1
  peg-in round-trip proven live on TON testnet 2026-07-01.
- **TON peg-out (detection + source validation)** — ✅ PROVEN end-to-end on testnet
  2026-07-01. Required fixing burn detection to parse `internal_transfer` (the real inbound
  message at the gateway jetton wallet) plus `GramHttpChain.getBurn` + the TON branch in
  `sourceValidator.ts` (offline-proven in `tools/gram-pegout-f2-spike.cjs`). Plan:
  `docs/plan-ton-pegout-source-validation.md`.
- **FEE_SWEEP / REFUND signer validation** — ✅ DONE 2026-07-01. These gateway-internal VIZ
  releases are now re-derived from the PEG_IN they settle (see the gateway-internal note
  above): FEE_SWEEP → own `fees.gate`, amount in the derived fee band; REFUND → gross to the
  original sender. Offline-proven in `tools/fee-sweep-refund-spike.cjs`. `recon`'s `unswept`
  now drains instead of growing without bound.
- **Fee split at mint** — mint `gross` with `net` to the user and `fee` to the
  treasury jetton wallet (keeps 1:1); the quote is already computed by the watcher.
- **Gas-wallet watermark** — auto-pause peg-in when the multisig TON balance is
  too low to mint (peg-out stays up). Not yet implemented.
- **Submit outbox/retry** — a failed coordinator submit currently logs and needs
  manual follow-up; add a persistent outbox before real volume.
