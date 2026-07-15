# Runbook — Mainnet per-operator bring-up (2-of-3, TON-only launch)

**Scope:** `plan-mainnet-deploy.md` Phase 4 (stack config & launch) + Phase 5 (smoke).
All on-chain prerequisites (Phases 1/3) are already done — see the state table below.
This runbook is the turnkey path for standing up the **federated multi-process**
gateway on mainnet: one coordinator box plus one signer daemon per operator.

> This is **not** the solo `docker compose` stack in `RUNBOOK.md` (that is a 1-of-1
> single-host bring-up). A real 2-of-3 runs each operator's signer on that
> operator's own hardware, under a separate person, on independent RPC.

---

## 0. Live mainnet state (prerequisites — already satisfied)

| Thing | Value | State |
|---|---|---|
| TON multisig (2-of-3) | `EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0` | live, liveness-proven, funded |
| wVIZ Jetton minter | `EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ` | admin = multisig, mintable, supply 0 |
| gateway jetton wallet | `EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy` | derived; watched for peg-out burns |
| `gram.gate` (GRAM backing) | VIZ active+master **2-of-3** | 0 VIZ (fills from peg-ins) |
| `fees.gate` (swept fees) | VIZ active+master **2-of-3** | 70 VIZ |
| `solana.gate` (dormant) | VIZ active+master **2-of-3** | 0 VIZ (Phase 2) |

Operator VIZ keyset (weight 1 each, threshold 2 — the same set on all three gate
accounts): `VIZ66354Nrsb…`, `VIZ7broTJHJj…`, `VIZ81beKM3eD…`.
Operator TON signer wallets (op-1/2/3, order baked into the multisig address):
`EQAng1Ia…`, `EQCk_GXt…`, `EQAj-bGk…`.

> ⚠️ **VIZ↔operator pairing in `federation.json` is provisional; the op-N labels here are a
> best guess.** The on-chain VIZ `key_auths` order need not match the op-1/2/3 TON signer
> order. Each signer's slot is **derived from its VIZ key**, not hand-set: at boot the signer
> looks up its own pubkey in `federation.json` to find its `op-N`, and the coordinator's
> key-anchored `SignerRegistry` independently confirms it at registration. So an operator
> never sets `OPERATOR_ID` (it's optional + advisory — supplied-but-wrong just warns and is
> overridden by the key). A key that isn't in the manifest at all fails loudly and closed at
> bring-up (`VIZ signing key (VIZ…) is not in federation.json's operator set`) — nothing
> silent. **What auto-derivation does *not* catch** is the manifest labeling the *wrong human*
> under a slot (both the label and your expectation come from the same guess): the signer will
> happily register under whatever slot its key is labeled for. So after each signer registers,
> confirm the `op-N` it logged matches the operator you expect. The rotation tooling likewise
> depends on the pairing — confirm the true VIZ↔operator↔TON-wallet mapping with the operators.

---

## 1. Topology & who runs what

```
                 ┌────────────────────── COORDINATOR box (one, e.g. op-1) ──────────────────────┐
   VIZ chain ───▶│ viz-watcher ─┐                                                                │
   TON chain ───▶│ gram-watcher ┼─▶ dispatcher ─▶ coordinator ──(POST /approve)──▶ each signer  │
                 │ recon        ┘   (keyless on TON: it holds NO signing key)                    │
                 └───────────────────────────────────────────────────────────────────┬─────────┘
                                                                                       │ /approve (per op)
        ┌──────────────── SIGNER box op-1 ─────────┐  ┌── op-2 ──┐  ┌── op-3 ──┐       │
        │ signer (SERVICE=signer, SIGNER_LISTEN)   │  │ signer   │  │ signer   │◀──────┘
        │ own FED_KEYSTORE (VIZ WIF + TON mnemonic)│  │ own keys │  │ own keys │
        │ own VIZ node + own TON endpoint (F2)     │  │ own RPC  │  │ own RPC  │
        └──────────────────────────────────────────┘  └──────────┘  └──────────┘
```

- **Coordinator box** (run by one operator, e.g. op-1): `viz-watcher`, `gram-watcher`,
  `coordinator`, `dispatcher`, `recon`. Holds **no signing key** — it proposes actions
  and collects approvals from the signers. On TON it is keyless: the on-chain
  propose/approve is performed by each operator's **signer** from that operator's own
  wallet.
- **Signer box** (one per operator, 3 total): the `signer` daemon. Holds this operator's
  VIZ WIF + TON multisig signer mnemonic (sealed in `FED_KEYSTORE`). Re-reads every
  source event from **its own** VIZ/TON nodes before signing (F2) and signs a VIZ release
  / proposes+approves a TON mint.

> An operator MAY co-locate their signer on the coordinator box, but the security model
> assumes ≥ a strict-majority of signers are on independent hardware under independent
> people. At 2-of-3, at least op-2 and op-3 must be genuinely independent.

---

## 2. F2 independence invariant (read before configuring any signer)

Each signer independently re-reads the source event from **its own** nodes. Therefore on
every signer box:

- `VIZ_NODE_URL` MUST be that operator's own VIZ node — never the coordinator's.
- `GRAM_ENDPOINT` / `GRAM_GATEWAY_JETTON_WALLET` MUST point at that operator's own TON
  node (used to re-read peg-out burns).

If a signer points these at the coordinator's RPC, F2 silently degrades to trusting the
coordinator. Nothing in the code can prove independence — **verify it per box**, and
alert if any signer's node URL resolves to the same host/IP as the coordinator (treat a
match as sev-1). See `docs/AUDIT.md §F2` and `RUNBOOK.md §5 F2`.

---

## 2b. Run every command from the repo root (relative paths)

`.env.mainnet` uses **relative** paths — `FEDERATION_MANIFEST=./federation.json`,
`STORE_URL=sqlite:./data/gateway.sqlite`, `FED_KEYSTORE=./keystore.mainnet.json`. Run
all `npm run start:*` commands with the repo checkout as the working directory.

> ⚠️ **Silent 1-of-1 hazard.** If `./federation.json` is not found (wrong CWD or a
> missing file), `loadConfig` falls back to count-only synthesis and boots as **1-of-1
> — no multisig protection**. It does not error. Your check that the real 2-of-3 loaded
> is the boot line: a coordinator/signer MUST log `threshold=2-of-3`. **If you see
> `threshold=1-of-1`, STOP** — the manifest was not found; fix the CWD/path before going
> further (also re-confirmed at §5 step 4 via `/health`).

---

## 3. Per-operator SIGNER box setup

Do this on **each** operator's machine (op-1, op-2, op-3).

### 3.1 Checkout + build
```bash
git clone https://github.com/viz-cx/viz-gateway.git && cd viz-gateway
npm ci && npm run build
```

### 3.2 Config
```bash
cp .env.mainnet.example .env.mainnet
```
Fill it in:
- `SERVICE=signer`. (No `OPERATOR_ID` needed — the signer derives its slot from your VIZ
  key via `federation.json`. Set it only to assert a slot; a wrong value warns and is
  overridden by the key.)
- `SIGNER_LISTEN=0.0.0.0:8100` (bind so the coordinator can reach `/approve`; put it
  behind mTLS/VPN — it is an authenticated-by-network surface). Default is `8100`, not
  `8090`: a co-located `viz-cpp-node` owns `8090`/`8091` (HTTP/WS RPC) and `8092`/`8093`
  (snapshot/wallet), so the `810x` block avoids an `EADDRINUSE` on the same host.
- `VIZ_NODE_URL` = **your own** VIZ node (F2).
- `GRAM_ENDPOINT` = **your own** TON node; keep the public `GRAM_*` addresses as shipped.
- `GRAM_API_KEY` = your own toncenter key.
- `SIGNER_ADVERTISE_URL` = the URL the coordinator can reach this signer at
  (e.g. `http://op-N-host:8100`) — the coordinator discovers you by self-registration.
- `COORDINATOR_URL` = the coordinator box's reachable URL (e.g. `http://coord-host:8080`).
- `VIZ_SIGNING_WIF` must be set (sealed in FED_KEYSTORE): the registration challenge is
  signed with your VIZ operator key and verified against your `vizPubkey` in federation.json.
- The coordinator no longer needs a `SIGNER_ENDPOINTS` list.

### 3.3 Seal your keys (no plaintext secrets on disk)
Put your two secrets in the env **temporarily**, seal, then unset:
```bash
export VIZ_SIGNING_WIF="<your VIZ active WIF>"          # one of the gram.gate 2-of-3 keys
export GRAM_SIGNER_MNEMONIC="<your 24-word TON mnemonic>" # your multisig signer wallet
node tools/keystore.cjs seal ./keystore.mainnet.json
unset VIZ_SIGNING_WIF GRAM_SIGNER_MNEMONIC
```
Then in `.env.mainnet`:
```
FED_KEYSTORE=./keystore.mainnet.json
# FED_KEYSTORE_PASSPHRASE=   # leave empty for an interactive TTY prompt at start
```
> Sanity-check your key matches your slot: your `VIZ_SIGNING_WIF`'s pubkey must be one of
> the three on `gram.gate`, and your TON wallet address must be your `op-N` entry in the
> multisig signer array. A mismatched key silently produces approvals the multisig/gate
> will reject.

### 3.4 Run
```bash
env $(grep -v '^#' .env.mainnet | xargs) npm run start:signer
```
Expect: `[signer] operator=op-N listening on 0.0.0.0:8100 (federation 2-of-3)`.
Health/behaviour: `POST /approve` is the only route; when the gateway is paused it
returns **423**. Confirm the coordinator box can reach `http://<op-N-host>:8100/approve`.

---

## 4. COORDINATOR box setup (one operator)

### 4.1 Config
```bash
cp .env.mainnet.example .env.mainnet   # or reuse the op-1 file that already has this block
```
- No `SIGNER_ENDPOINTS`: signers self-register. `GET /health` reports
  `{registered, expected}`; wait for `registered` to reach the threshold before smoke-testing.
- `REGISTRATION_LEASE_MS` / `REGISTRATION_HEARTBEAT_MS` / `REGISTRATION_NONCE_TTL_MS` may be
  left at defaults (60s / 20s / 30s).
- `COORDINATOR_LISTEN=0.0.0.0:8080`, `COORDINATOR_URL=http://127.0.0.1:8080`.
- `FEDERATION_MANIFEST=./federation.json` (2-of-3 is read from here).
- `RECON_EXPECTED_REMOTES=GRAM` (TON-only launch — recon fails closed if GRAM is missing
  and does not expect a Solana remote yet).
- Caps: `CAP_*`/`MANUAL_REVIEW_*` set to the effectively-infinite launch values (unlimited,
  Phase 0 decision — see the template comments).
- `STAFF_WEBHOOK_URL` — set a real alert channel (a prod custody bridge MUST).
- The coordinator holds **no** signing key; leave `VIZ_SIGNING_WIF`/`GRAM_SIGNER_MNEMONIC`
  unset on this box.

### 4.2 Run the five processes (each its own SERVICE)

> **The processes do NOT auto-load `.env.mainnet`** (there is no dotenv). You must
> inject the file into each process's environment — either via a process manager /
> container `env_file`, or by prefixing the command as shown (same idiom as §3.4).
> A bare `npm run start:*` boots on built-in defaults and fails closed on the missing
> GRAM account — it does **not** silently run with wrong config.

```bash
LOAD='env $(grep -v "^#" .env.mainnet | xargs)'   # inject .env.mainnet into the process

eval "$LOAD" SERVICE=viz-watcher   npm run start:viz-watcher
eval "$LOAD" SERVICE=gram-watcher  npm run start:gram-watcher
eval "$LOAD" SERVICE=coordinator   npm run start:coordinator
eval "$LOAD" SERVICE=dispatcher    npm run start:dispatcher
eval "$LOAD" SERVICE=recon         npm run start:recon
```
(Run each under a process manager / one container each; all read the same
`.env.mainnet`. `SERVICE=` is documentary for the npm path — the `start:*` script
selects the process — but keep it set so a container/entrypoint that dispatches on
`$SERVICE` also works.)

Expect:
- `[coordinator] listening on 0.0.0.0:8080; threshold=2-of-3; awaiting 3 signer registration(s)`
  (`GET /health` initially shows `registered=0, expected=3`; climbs as each signer starts).
- `recon` reports per-chain `locked ≥ circulating + unswept`, `status=OK`. On an empty
  system this is `locked=0 circulating=0` for GRAM.

---

## 5. Launch order

1. Start the coordinator; `GET /health` shows `registered=0, expected=N`.
2. Start each operator's signer. Each self-registers within one heartbeat; watch
   `[coordinator] registered op-N -> http://…` and `/health` `registered` climb to N.
3. Multisig funded for mint gas (as before).
4. Confirm `/health` shows `registered=N` (≥ threshold) before the smoke proof.

---

## 6. Phase 5 — mainnet smoke proof (small value)

Run with minimal value and confirm each leg + recon drift = 0. Mirror the testnet
§9b record into `RUNBOOK.md` when done.

- **Peg-in:** send a small VIZ amount to `gram.gate` with the memo = a TON address.
  Expect: `viz-watcher` detects the lock → coordinator proposes a mint → the three
  signers propose/approve on-chain from their own wallets → 2-of-3 → mint executes →
  net wVIZ (gross − fee) lands; the fee is swept to `fees.gate`.
- **Peg-out:** from the recipient TON wallet, send the wVIZ to
  `EQCjDw0J…` (the gateway jetton wallet) with a text comment = a VIZ account name.
  Expect: `gram-watcher` detects the burn → each signer re-reads it on its own node →
  coordinator collects 2-of-3 VIZ-release signatures → VIZ released from `gram.gate` to
  the account.
- Confirm `recon` drift = 0 after the round-trip.

### Drills (small value)
- **Crash-window:** kill the coordinator mid-flight → on restart, no double mint/release.
- **Under-threshold:** stop 2 of 3 signers → only 1 left → `broadcast:false`, no theft.
- **Pause:** trip a pause → signers return **423** on `/approve`.

---

## 7. Safety recap

- **F2:** every signer on its OWN independent RPC (§2). A shared endpoint = sev-1.
- **Keys:** never share a WIF/mnemonic; if any one box holds ≥2 operators' secrets the
  2-of-3 is fake. Seal secrets in `FED_KEYSTORE`, no plaintext on disk.
- **Caps unlimited:** blast radius on a key compromise or coordinator bug = the whole
  backing balance. Keep launch value small; tighten caps as TVL/the federation grow.
- **gram.gate funding:** not pre-funded — peg-ins fill it, so `locked ≥ circulating`
  holds from 0. Do not send VIZ to a gate account while pondering a rollback of its
  2-of-3 authority.
- **Solana:** dormant this launch (`solana.gate` stays 0, `RECON_EXPECTED_REMOTES=GRAM`);
  add it at Phase 2.
