# viz-ton-gateway

[![CI](https://github.com/viz-cx/viz-ton-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/viz-cx/viz-ton-gateway/actions/workflows/ci.yml)

Federated multisig gateway between the **VIZ blockchain** and **TON**:
lock VIZ on VIZ, mint wrapped VIZ (`wVIZ`, a TON Jetton) — and the reverse.
Secured by an **M-of-N signer federation** that uses the native multisig of both
chains. Default and recommended: **5-of-7**.

The full research, security math, and rollout plan are in
[`VIZ-TON-Gateway-Research-and-Plan.md`](./VIZ-TON-Gateway-Research-and-Plan.md).

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
contracts-ton/         multisig-v2 + Jetton deploy scripts (dry-run by default) + setup
tools/threshold-calc.mjs   the federation-size numbers
```

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

What still needs live contracts (not stubbed logic — missing on-chain targets):
the actual `broadcastRelease` (needs a funded 5-of-7 gateway account on VIZ) and
`submitMintOrder` (needs the deployed multisig-v2 to assemble the execute
message via its wrapper). The 24h cap counters are still per-process (the pause
they trigger is shared). Nothing here moves real funds yet.

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
