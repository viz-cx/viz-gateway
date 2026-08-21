# Runbook — Solana devnet proof & mainnet cutover

Turnkey path to prove the Solana peg-in mint and peg-out burn against a real
cluster, then the checklist to take Solana from devnet to mainnet (Phase 2 of
[`docs/plan-mainnet-deploy.md`](./plan-mainnet-deploy.md)).

The Solana **code** is done and offline-verified in `npm run verify`
(`solana-*-spike.cjs`). What this runbook covers is the part that needs a live
chain and can't run in CI: deployed contracts, a funded submitter, and the two
on-chain round-trip proofs.

## TL;DR

```bash
# one-time: build the workspace
npm install && npm run build

# prove BOTH paths against a throwaway local validator, from zero:
tools/solana-devnet-proof-all.sh
```

That script boots a fresh `solana-test-validator`, `anchor build`s the
`gateway_deposit` program if needed, runs the peg-out burn proof and the peg-in
mint round-trip, and tears the validator down. Both proofs must print
`RESULT: ... PROVEN`.

`PROOF=pegin` or `PROOF=pegout` runs just one; `KEEP_VALIDATOR=1` leaves the
validator up for inspection.

---

## 1. Prerequisites (install once)

Everything below is no-root, per-user. Pin versions to the ones in the
verification records at the bottom of `RUNBOOK.md`.

### Node + workspace
```bash
node -v            # need >= 22 (packages/common/store.js uses node:sqlite)
npm install
npm run build      # produces the dist/ the proof scripts require()
```

### Solana CLI (agave) — needed for BOTH proofs
Provides `solana`, `solana-keygen`, `solana-test-validator`.
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version   # e.g. agave 2.x / solana-cli 2.x
```

### Rust — needed ONLY for the peg-out proof
The peg-out proof deploys the `gateway_deposit` program, so it needs the
compiled `.so`, built by `cargo build-sbf` (ships with the agave install above;
it needs a host `cargo` for metadata, hence rustup). No Anchor — the program is
pinocchio (no_std) since 2026-08-20.
```bash
# Rust (pinned by contracts/solana/rust-toolchain.toml -> 1.89.0)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
( cd contracts/solana && cargo build-sbf )   # target/deploy/gateway_deposit.so (~16 KB)
```

If you skip Rust, run `PROOF=pegin tools/solana-devnet-proof-all.sh`.

---

## 2. Run the proofs (local validator, zero real funds)

```bash
tools/solana-devnet-proof-all.sh
```

What it does, in order:
1. Preflight: checks `solana*`, `node`, and the built `dist/` are present.
2. If proving peg-out and `contracts/solana/target/deploy/gateway_deposit.so` is
   absent, runs `anchor build` (the one step not otherwise documented).
3. Boots `solana-test-validator --reset` on `http://127.0.0.1:8899` and waits for
   RPC readiness (no blind sleep).
4. **Peg-out proof** (`tools/solana-pegout-proof.cjs`): deploys `gateway_deposit`,
   creates a Token-2022 wVIZ mint, mints to the deposit PDA's ATA, calls
   `burn_deposit`, and asserts the ATA balance and mint supply both dropped by the
   burned amount.
5. **Peg-in proof** (`tools/solana-devnet-proof.cjs`): generates throwaway keys,
   deploys the wVIZ mint + a **2-of-2** SPL multisig (`npm run deploy:solana`),
   creates a durable nonce account (authority = submitter), then drives the real
   `SolanaChain.buildMintProposal` → two `KeyedSigner.approveSolanaMint` partials →
   `SolanaChain.submitMint`, and asserts the recipient's wVIZ ATA rose by NET and
   that `mintByActionId` locates the tx by its SPL-Memo action id.

Expected tail:
```
RESULT: Solana peg-out burn_deposit PROVEN.
RESULT: live Solana mint round-trip PROVEN. NET=... minted to ... in tx ...
[proof-all] ALL REQUESTED PROOFS PASSED (PROOF=both)
```

> The **public devnet faucet is rate-limited**; a local `solana-test-validator`
> exercises identical program paths (Token-2022 + SPL multisig + durable nonce)
> and airdrops freely. Prove locally first. To point at devnet instead, set
> `SOLANA_RPC_URL=https://api.devnet.solana.com` and fund the payer/submitter from
> a faucet rather than `solana airdrop`.

The equivalent manual sequences (for debugging one step) remain in `RUNBOOK.md`
under "How peg-in mint works on Solana" and "How peg-out burn works on Solana".

---

## 2b. Run the proofs on public devnet (no local toolchain)

`tools/solana-devnet-run.cjs` is the devnet counterpart of the local driver,
pure Node — keygen, faucet funding, `deploy:solana`, and the durable nonce all
go through `@solana/web3.js`, so **no solana CLI, Rust, or Anchor is needed**:

```bash
node tools/solana-devnet-run.cjs           # both proofs; PROOF=pegin|pegout for one
```

Keys and the deployed mint/multisig persist in `~/.viz-solana-devnet-proof/`,
so reruns reuse faucet funds. When the RPC faucet is dry (usual), the script
prints the payer/submitter pubkeys to fund at https://faucet.solana.com.

The peg-out proof needs `gateway_deposit` **on devnet**. Devnet purges idle
programs (the July deploy of `MCFeMZJY…` is gone), so to (re)deploy:
1. Generate a program keypair locally; it never leaves your machine.
2. Get the `.so`: `cargo build-sbf` locally, or the `Solana program build`
   workflow artifact. The pinocchio program has **no `declare_id!`** — one
   id-agnostic build (~16 KB) deploys under any program id, no source patching.
3. Deploy with only the `solana` binary (25 MB, extractable alone from the
   agave release tarball) and a payer holding ~0.25 SOL for peak rent:
   `solana program deploy <so> --program-id <keypair> --keypair <payer> -u devnet`.
4. `SOLANA_PROGRAM_ID=<pubkey> PROOF=pegout node tools/solana-devnet-run.cjs`.

Verification record — 2026-08-21, both proofs PROVEN on devnet against the
**pinocchio Anchor-error-parity** build (16,992 B, upgraded in place):
peg-in mint tx `3qYGtNeByjPSkYnEey8FoyjV6VzyvsPTUvfRef7bEuGKFZbQCnVM4XaHJKM1J7SxgoeFVwhGTW3E1NSrC7viTk6L`
(mint `3wWjWQwW9QzZpzLnoXGZnJjhP6yrXvWw2CvkQDsVxqaT`, 2-of-2 multisig
`CpwvWZhw4CaqyjHEMx8GGiDPfD5PjB2hUCgCedxkN1PU`); peg-out burn tx
`L2PghaPBg4Q96unjdwJXKUCKuiLibvWzWDfZKopLoVYpD7YgxL6deK6qtJuuijMXKoiq4N8A33Hk1Htgvg1qEoh`
(program `4WuuUFPA6f4RD2MMb6uFt44zSUSAMpn4EE93cEuujQ3y`); the upgrade-authority
tool was also proven live (dry-run SECURED + fail-closed + APPLY round-trip, see
PROVENANCE.md). Initial deploy 2026-08-20 (16,184 B build) cost 0.115 SOL net.
Previous record (2026-08-15, Anchor build, program `BjgxrYA4…` — superseded):
peg-in `3peWbRt…QxzC`, peg-out `3SbhKJT…ya7e`.

---

## 3. Mainnet cutover checklist (Phase 2)

Do this only after both proofs pass on a local validator AND a devnet run. This
is the deferred part of `docs/plan-mainnet-deploy.md` §"Phase 2 — Solana mainnet".
All env keys are in `.env.example` (the `# --- Solana chain` block).

### 3a. Deploy the contracts (mainnet-beta)
- [ ] Generate a **fresh** program keypair locally (never one whose pubkey has
      already appeared in this repo or its CI — a pre-announced id can be squatted
      on mainnet first; the devnet `BjgxrYA4…` and `4WuuUFPA…` are burned for this purpose). The
      pinocchio `.so` is id-agnostic (no `declare_id!`), so the pubkey never
      needs to reach CI at all: build once, deploy under the fresh keypair
      whenever the payer is ready. Log the id in
      `contracts/solana/PROVENANCE.md`.
      **Cost:** rent is ~6,960 lamports/byte, so the ~16 KB pinocchio `.so`
      locks ~0.12 SOL in programdata plus a same-size buffer deposit **refunded
      when the deploy finalizes** — peak float ~0.24 SOL, net ~0.12. Pass
      `--max-len` ≈ the actual binary size so programdata doesn't default to 2×.
      `solana program extend` can grow it later, but agave enforces a 10,240-byte
      **minimum** extension (~0.071 SOL extra rent), so a couple KB of `--max-len`
      headroom up front is cheaper than the smallest possible extend.
- [ ] Deploy the wVIZ **Token-2022 mint** + **SPL M-of-N multisig** (mint+freeze
      authority) with the real operator pubkeys:
      `SOLANA_SIGNERS=<op1,op2,...> SOLANA_THRESHOLD=<M> DEPLOY_SEND=1
       SOLANA_PAYER_SECRET=<funded> SOLANA_RPC_URL=<mainnet> npm run deploy:solana`.
      Record `SOLANA_WVIZ_MINT` and `SOLANA_MULTISIG`.
- [ ] Create the durable **nonce account**, authority = submitter; set
      `SOLANA_NONCE_ACCOUNT` / `SOLANA_ROTATION_NONCE_ACCOUNT`.
- [ ] Create the gateway's **wVIZ token account** for peg-out deposits; set
      `SOLANA_GATEWAY_TOKEN_ACCOUNT`.

### 3b. Lock down the program upgrade authority
- [ ] Hand the `gateway_deposit` upgrade authority to the Squads-style multisig
      and **verify**: `SOLANA_DEPOSIT_PROGRAM_ID=<id> SOLANA_UPGRADE_MULTISIG=<pda>
      npm run authority:solana` (dry-run), then `APPLY=1` to reassign. It must
      report `SECURED` (or `IMMUTABLE`), never `UNSAFE`/`MISCONFIGURED`.
- [ ] Confirm **no** `SOLANA_DEPOSIT_MASTER_SEED` is set anywhere (PDA custody
      only; no seed-based deposit addresses on mainnet).

### 3c. Fund + wire the runtime
- [ ] Fund the **submitter** (`SOLANA_SUBMITTER_SECRET`) with SOL for fee-payer +
      nonce + ATA rent; set `SOLANA_SUBMITTER_PUBKEY` so signers pin `feePayer`,
      and `SOLANA_SUBMITTER_MIN_LAMPORTS` for the recon reserve alert.
- [ ] Each operator sets its own `SOLANA_SIGNER_SECRET` (multisig member key).
- [ ] Point signers' `SOLANA_RPC_URL` at each operator's **own** RPC (F2 source
      re-read must not run through the coordinator's node — see RUNBOOK §F2).
- [ ] Set `SOLANA_DEPOSIT_PROGRAM_ID` on lookup, scanner, and all signers.
- [ ] Provision the VIZ backing account `solana.gate` and fund it to match the
      minted wVIZ (kept at 0 until go-live); set `VIZ_GATEWAY_ACCOUNT_SOLANA`.

### 3d. Turn recon on for Solana (the go-live flip)
- [ ] Add `SOLANA` to `RECON_EXPECTED_REMOTES` (e.g. `GRAM,SOLANA`) so recon
      **fails closed** if the Solana supply/backing read is unavailable rather
      than silently ignoring the remote.
- [ ] Start `start:solana-watcher`, `start:lookup`, `start:pegout-scanner`.
- [ ] `RECON_ONCE=1 npm run start:recon` → the SOLANA row shows `status=OK`,
      drift 0, locked ≥ circulating.
- [ ] The site's multi-chain reconciliation panel now shows a **Solana** card
      automatically (frontend already renders every chain `/recon` returns).

### 3e. Small-amount live drill
- [ ] Real peg-in of a tiny amount → wVIZ lands in the recipient ATA; recon stays
      balanced.
- [ ] Real peg-out of that wVIZ to a deposit PDA → `burn_deposit` fires, VIZ is
      released on `solana.gate`, recon returns to 0 drift.
- [ ] Pause drill: force a mismatch, confirm the whole gateway pauses and the
      signer returns HTTP 423; unpause to resume.

---

## References
- `tools/solana-devnet-proof-all.sh` — the turnkey driver.
- `tools/solana-pegout-proof.cjs`, `tools/solana-devnet-proof.cjs` — the proofs.
- `RUNBOOK.md` — manual per-step Solana sequences + verification records.
- `docs/plan-mainnet-deploy.md` — the full mainnet plan (Phase 2 = Solana).
- `contracts/solana/PROVENANCE.md` — bytecode/address pinning.
