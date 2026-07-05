# AGENTS.md — working in viz-gateway

Guidance for AI agents (and humans) contributing to this repo. Keep it short and current.

## What this is

A federated multisig gateway between **VIZ** and remote chains (TON live, Solana read-path prepped):
lock VIZ → mint wrapped VIZ, and back. Secured by an **M-of-N operator federation** (default 5-of-7,
bootstraps at 1-of-1). Operators are trusted key-pairs — **no VIZ validator status required** — and the
active set governs itself via T-of-N rotation (see `setup-viz/src/rotate.ts` and
`specs/2026-06-21-open-operator-rotation-design.md`).

## Layout

| Path | Role |
|------|------|
| `packages/common` | Shared, dependency-light core: types, config, caps, fees, idempotency, store, **rotation logic** (`rotation.ts`). |
| `packages/viz-watcher` / `gram-watcher` / `solana-watcher` | Per-chain event watchers (the `RemoteChain` adapter pattern). |
| `packages/signer` | The only component with keys: validates + signs (one per operator). |
| `packages/coordinator` | Keyless orchestration of a peg: builds the one shared proposal, collects partials, broadcasts. Not involved in operator rotation. |
| `packages/recon` | Reconciliation / circuit-breaker. |
| `setup-viz` | One-time VIZ account setup (`setupAccount.ts`) + the operator-rotation CLI (`rotate.ts`). |
| `contracts/ton` / `contracts/solana` | Remote-chain contracts + deploy scripts. |
| `tools/*.cjs`, `tools/*.mjs` | Offline `node:assert` test/spike scripts — **this is the test suite** (no jest/vitest). |

## Build & test

```bash
npm install        # REQUIRED first — see the TypeScript pin note below
npm run build      # tsc -b across all workspaces (project references)
npm run verify     # runs every tools/*-spike after build; this is CI
```

- **Tests are offline `node:assert` spikes** wired into `npm run verify`. Add a new feature → add a
  `tools/<name>-spike.cjs` and append it to the `verify` script in the root `package.json`.
- `verify` requires `dist/` to exist (spikes `require("../packages/*/dist/...")`), so always `npm run build`
  first. If a spike fails with `MODULE_NOT_FOUND` after deleting `dist/`, you also deleted state without the
  matching `*.tsbuildinfo`; run `npm run build -- --force`.

## TypeScript version (gotcha)

The repo pins `typescript ^5.4.0`. TS **6.x/7.x hard-errors** on this repo's `baseUrl` +
`moduleResolution: Node` (deprecated). If `node_modules` is absent, `npx tsc` will fetch the latest (6.x) and
the build fails with `TS5101`/`TS5107`. **Always `npm install` first** so the local pinned 5.x tsc
(`node_modules/.bin/tsc`) is used.

## Dependency security

`npm audit` flags advisories in transitive deps of `@solana/web3.js`, none in our own code.
Last triaged 2026-07-01 — current state is **8 findings (3 high, 5 moderate), all one Solana chain**;
**accepted** (don't re-triage; revisit only on dependency upgrades):

| Advisory | Sev | Via | Why accepted |
|----------|-----|-----|--------------|
| `bigint-buffer@1.1.5` (buffer overflow) | high | `@solana/spl-token`→`buffer-layout-utils` | No upstream patch (1.1.5 is latest; advisory covers all versions). Write-path partials are operator-signed; read path parses trusted-RPC data. We're on the latest `@solana/spl-token@0.4.14`; clears only when it drops the dep or on a web3.js v2 migration. The `@solana/web3.js`/`spl-token*` rows in `npm audit` are the same root cause re-counted. |
| `uuid@8.3.2` (bounds check) | moderate | `@solana/web3.js`→`jayson` | Not exploitable — jayson uses `v4()`, never the vulnerable `buf` arg. |

Advisories that **were** fixed (no longer in the tree — keep these notes so they aren't reintroduced):
- `ws` (high DoS) — patched via `overrides: { "ws": "^8.18.0" }` in the root `package.json` (viz-js-lib pins
  `ws@^1.x`, no in-range fix; resolves to `ws@8.21.0`). If you add a dep that needs ws@1 behavior, revisit it.
- `form-data` (high CRLF injection) — resolved by `form-data@4.0.6` arriving transitively via `@ton/ton`→`axios`.
- `babel-traverse@6` (critical ACE on compile) — gone since `viz-js-lib@^0.12.7` (registry move) dropped the
  babel-6 build chain. No override needed.

Note: GitHub Dependabot may still show stale **open** alerts for `ws`/`form-data` until its next scan — the
patched versions are already in the committed lockfile (verified via `npm audit`), so those alerts are
informational lag, not live exposure.

## Conventions

- **Match the surrounding file**: comment density, naming, idiom. Code is terse and well-commented at decision points.
- **No new runtime deps** in `packages/common` — it must stay dependency-light. Chain libs live in the watcher/setup packages.
- **VIZ multisig signing**: `signTransaction` does **not** guarantee signature array order. To extract one
  operator's partial, sign a clone with `signatures: []` and take `[0]`; never index out of an accumulated
  array. (Proven in `tools/viz-multisig-spike.cjs`; relied on by rotation.)
- **Commits**: imperative subject, body explains the "why". No `Co-Authored-By` trailer.
- **Secrets**: never commit `.env` (only `.env.example`). The public federation manifest (`federation.json`,
  operator ids + pubkeys) is committable; per-operator keys are not.

## Solana program (`contracts/solana`)

The `contracts/solana/` directory contains both TypeScript deploy scripts (Token-2022 mint) and a
native Rust/Anchor program (`programs/gateway-deposit`). The Anchor workspace is rooted at
`contracts/solana/Anchor.toml`.

**Toolchain versions (installed 2026-07-02):**
| Tool | Version |
|------|---------|
| `rustc` (host, via rustup) | 1.96.1 |
| `rustc` (pinned, via `rust-toolchain.toml`) | 1.89.0 — used for all `contracts/solana` builds |
| `solana-cli` (Agave) | 3.1.10 |
| `anchor-cli` (avm) | 1.1.2 |

**Prerequisites:** Rust (`rustup`), Agave Solana CLI, and `avm` must be installed and on PATH.
Add to your shell profile:
```bash
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

**Build & test commands:**
```bash
cd contracts/solana
anchor build          # compiles the Anchor program; produces target/idl/gateway_deposit.json
anchor test           # runs the Anchor test suite (litesvm-based)
```

**Security note:** `target/deploy/gateway_deposit-keypair.json` is the on-chain program keypair —
treat it as a deploy secret. It is git-ignored via `contracts/solana/.gitignore`. **Never commit it.**
The IDL (`target/idl/gateway_deposit.json`) IS committed (it is a build artifact needed by the TS client).

## Operator rotation (VIZ side, implemented)

`npm run rotate -- propose|co-sign|broadcast viz`. A rotation is one VIZ `account_update` rewriting
`active`/`regular` to the new key set; `master` is omitted so only the current active T-of-N is required (no
guardian). All partials bind the same TaPoS-fixed tx, so the ceremony must complete within VIZ's 1-hour
window. The TON side (`npm run rotate:gram -- submit-gram|approve-gram|status`) is on-chain async
approval via the vendored multisig-v2 wrappers (`contracts/ton/src/wrappers`, pinned);
signers are WalletV4 addresses derived from each operator's `tonPubkey`.
See `RUNBOOK.md` → "Rotating the operator set".
