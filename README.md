# viz-gateway

[![CI](https://github.com/viz-cx/viz-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/viz-cx/viz-gateway/actions/workflows/ci.yml)

Federated multisig gateway between the **VIZ blockchain** and external networks
(TON live, Solana in progress). Lock VIZ on VIZ, mint wrapped VIZ (`wVIZ`) on
the remote chain — and the reverse. Each remote chain is a pluggable adapter;
adding a new network requires no changes to the trust-critical core.
Secured by an **M-of-N signer federation**. Default and recommended: **5-of-7**.

The full research, security math, and rollout plan are in
[`VIZ-Gateway-Research-and-Plan.md`](./VIZ-Gateway-Research-and-Plan.md).
To stand it up solo on testnet, follow [`RUNBOOK.md`](./RUNBOOK.md).

## Why 5-of-7

A custody multisig trades theft-resistance against freeze-resistance. `5-of-7`
is the BFT-clean point for `f = 2`: an attacker needs **5 of 7** independent keys
to steal, and the bridge keeps running with **2 operators offline**. Reproduce
the numbers:

```
node tools/threshold-calc.mjs
```

## Layout

```
packages/common        trust-critical core: canonical mapping, idempotency, caps, threshold
packages/viz-watcher   follows VIZ irreversible head, detects deposits (peg-in)
packages/ton-watcher   follows TON finality, detects wVIZ burns (peg-out)
packages/signer        the only component with keys; validates + signs (one per operator)
packages/coordinator   UNTRUSTED; collects approvals, broadcasts once threshold met
packages/recon         enforces locked-VIZ == circulating-wVIZ; auto-pauses on drift
packages/solana-watcher  Solana remote-chain adapter + watcher (read path live; mint deferred)
contracts/ton/         multisig-v2 + Jetton deploy scripts (dry-run by default) + setup
contracts/solana/      Token-2022 wVIZ mint + SPL multisig deploy script (dry-run by default)
setup-viz/             one-time VIZ gateway account setup (3-of-4 guardian master)
tools/threshold-calc.mjs   the federation-size numbers
```

## Fees & minimum

VIZ side is free; peg-out is free. The only fee is on **peg-in**, to cover the
TON mint gas (+ small margin), collected in wVIZ at mint time so the 1:1 backing
holds. At 1 VIZ=$0.005, 1 TON=$2:

- **Fee = max(100 VIZ, 0.30%)** — floor ~$0.50 ≈ 0.25 TON (~2.5× worst-case mint gas); 0.30% only bites above ~33,333 VIZ.
- **Minimum peg-in = 2,000 VIZ (~$10)** — below this, gas dominates and it's flagged for refund.

Config: `FEE_FLOOR_MILLI_VIZ`, `FEE_BPS`, `MIN_PEGIN_MILLI_VIZ` (see `.env.example`);
math in plan §12, verified by `tools/fees-spike.cjs`.

## Status

Early but partly live. The trust-critical core (`packages/common`) is
implemented and typechecks. Both **read paths are wired**:

- **VIZ** (`VizJsChain`) — verified against `https://node.viz.cx`: reads the
  irreversible head (~14-block lag), detects and parses real deposits, reads
  balances.
- **TON** (`TonHttpChain`) — verified against toncenter: reads masterchain
  seqno and Jetton total supply live; the `transfer_notification` parser used
  for peg-out detection round-trips for both payload encodings
  (`tools/ton-notification-spike.cjs`).

The **reconciliation job is wired** (`recon`): it computes locked-VIZ vs
circulating-wVIZ from both live adapters and, on drift, trips the shared pause
(verified — mismatched endpoints trip `CRITICAL` + non-zero exit; a matched 0/0
reports `OK`). Run a one-shot check with `RECON_ONCE=1`.

**Persistence + shared pause are wired** (`SqliteGatewayStore`, `node:sqlite`):
the idempotency ledger and a global pause flag live in one SQLite file shared
across all processes. Verified across separate processes — a deposit claimed by
one process is rejected by another, and a pause tripped by `recon` is honored by
the watchers (which stop scanning) and the signer (which returns HTTP 423).
Clearing the pause is a deliberate `unpause()`, never automatic.

**Write-path signing is implemented and verified** (`KeyedSigner`, `vizSign`,
`tonSign`): operators validate the proposal against the action they derived
independently, then sign. Verified through the real signer
(`tools/writepaths-spike.cjs`): two operators' independent VIZ partial
signatures merge to the same set as a single all-keys signing; the VIZ proposal
builder derives live TaPoS from `node.viz.cx`; tampered proposals are rejected;
the TON ed25519 mint approval verifies and a tampered order hash fails.

**Orchestration is wired** (`coordinator` → `Orchestrator`): a watcher detects an
event and POSTs it to the coordinator, which builds the one shared proposal, asks
each signer to validate+sign, and broadcasts once the threshold is met. Verified
(`tools/orchestration-spike.cjs`) to complete a peg at **1-of-1** and **2-of-3**
with real signatures, stop collecting at threshold, and refuse under-threshold or
rogue signers. Defaults to **1-of-1** so a single operator (you) can run a
working bridge solo; grow by adding signer keys and raising the threshold — no
redeploy.

### Open operator set & rotation

Operators need **no VIZ validator status** — an operator is just a VIZ secp256k1 +
TON ed25519 keypair the existing operators chose to trust. The active set governs
itself: any operator runs `rotate propose` with the new set + threshold, others
`rotate co-sign`, and once T partials are collected `rotate broadcast viz` rewrites
the gateway's VIZ `active` authority. No guardian on the normal path; the
`MASTER_GUARDIANS` council is last-resort recovery only.

You can self-remove up to **N − T** operators while keeping liveness; below that,
recovery falls to the guardians. VIZ partials must be collected and broadcast within
one hour (the chain's TaPoS window), so a rotation is a short coordinated ceremony.
The public `federation.json` (operator ids + pubkeys) is committable; per-operator
secrets stay in each operator's `.env`. The TON side is on-chain and asynchronous: `rotate:ton submit-ton` posts an
`update_multisig_params` order, each current signer runs `rotate:ton approve-ton`,
and `rotate:ton status` confirms once the multisig signer set has changed.

**Solana is prepped** (`packages/solana-watcher`, `contracts/solana`) as the
second remote chain via the shared `RemoteChain` interface: the read adapter
(finalized slot, supply, burn detection) is verified against live RPC, and the
Token-2022 + SPL-multisig deploy script dry-runs. Solana's mint write-path is
deferred until the TON round-trip validates the interface.

What still needs live contracts (not stubbed logic — missing on-chain targets):
the actual `broadcastRelease` (needs a funded gateway account on VIZ) and the
remote `submitMint` (TON: on-chain multisig-v2 order; Solana: SPL-multisig mint).
The 24h cap counters are still per-process (the pause they trigger is shared).
Nothing here moves real funds yet.

## Build & run (local)

```
npm install
npm run build
npm run threshold        # prints the 5-of-7 analysis
```

## Run an operator node (Docker)

Each trusted operator:

```
cp .env.example .env     # fill in YOUR secrets (VIZ_SIGNING_WIF, TON_SIGNER_MNEMONIC)
docker compose up --build
```

That starts this operator's watchers + signer + recon. The public federation
manifest (the 7 public keys, gateway addresses, threshold, caps) is shared and
committable; the per-operator secrets in `.env` are never shared or committed.

Run the coordinator (any one operator, or rotate):

```
docker compose -f docker-compose.coordinator.yml up --build
```

## Security model in one paragraph

Each operator independently verifies the source-chain event against its own
nodes and signs only the deterministic *canonical* action it recomputes locally.
The coordinator holds no keys, so compromising it cannot cause theft — only a
liveness stall, which any operator can resolve by self-hosting one. Funds move
only after source-chain finality (VIZ irreversibility / TON masterchain), and a
reconciliation job halts everything on any peg drift. See the plan doc for the
full threat table.
