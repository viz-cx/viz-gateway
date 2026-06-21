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
| `packages/viz-watcher` / `ton-watcher` / `solana-watcher` | Per-chain event watchers (the `RemoteChain` adapter pattern). |
| `packages/signer` | The only component with keys: validates + signs (one per operator). |
| `packages/coordinator` | Keyless orchestration of a peg: builds the one shared proposal, collects partials, broadcasts. Not involved in operator rotation. |
| `packages/recon` | Reconciliation / circuit-breaker. |
| `setup-viz` | One-time VIZ account setup (`setupAccount.ts`) + the operator-rotation CLI (`rotate.ts`). |
| `contracts-ton` / `contracts-solana` | Remote-chain contracts + deploy scripts. |
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

## Conventions

- **Match the surrounding file**: comment density, naming, idiom. Code is terse and well-commented at decision points.
- **No new runtime deps** in `packages/common` — it must stay dependency-light. Chain libs live in the watcher/setup packages.
- **VIZ multisig signing**: `signTransaction` does **not** guarantee signature array order. To extract one
  operator's partial, sign a clone with `signatures: []` and take `[0]`; never index out of an accumulated
  array. (Proven in `tools/viz-multisig-spike.cjs`; relied on by rotation.)
- **Commits**: imperative subject, body explains the "why". No `Co-Authored-By` trailer.
- **Secrets**: never commit `.env` (only `.env.example`). The public federation manifest (`federation.json`,
  operator ids + pubkeys) is committable; per-operator keys are not.

## Operator rotation (VIZ side, implemented)

`npm run rotate -- propose|co-sign|broadcast viz`. A rotation is one VIZ `account_update` rewriting
`active`/`regular` to the new key set; `master` is omitted so only the current active T-of-N is required (no
guardian). All partials bind the same TaPoS-fixed tx, so the ceremony must complete within VIZ's 1-hour
window. The TON side (`submit-ton`/`approve-ton`/`status`, on-chain async approval) is a deferred follow-up.
See `RUNBOOK.md` → "Rotating the operator set".
