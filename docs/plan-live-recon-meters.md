# Plan — live reconciliation meters on the landing page (`#how`)

**Goal.** The two "pool" bars in the *Live reconciliation* card (`site/index.html`
`.meter-row`, in the **Security** section — reached by scrolling on from `#how`) are
decoration: `site.css:619` hardcodes `width: 100%` and animates a `sweep`. Replace them
with the real figures recon already computes, sourced from a new public `GET /recon`
endpoint on the coordinator.

**Status: IMPLEMENTED** (this session). 307 unit tests + `npm run verify` green.

**Chosen approach (B).** `Recon.check()` computes `locked`, `circulating`,
`unsweptFees` and `drift` every tick and logs them (`packages/recon/src/checker.ts:135`).
Persist that snapshot to the existing `gateway_state` KV, serve it from the coordinator,
and let the landing page render it in **one same-origin fetch**. Rejected alternative:
client-side chain reads via `site/token-stats.js` — two rate-limited public toncenter
`runGetMethod` calls and no visibility into `unsweptFees`, which lives only in SQLite.

## Honesty constraint (drives the markup)

The card today asserts `locked = circulating` with an `=` between the bars. Live that is
false: the gateway carries a structural **over-backing** (+47.5 VIZ as of 2026-08-04),
growing ~37.5 mVIZ·10³ per GRAM peg-in from the retained activation surcharge.

So render the *actual* invariant, `locked ≥ circulating + unsweptFees`:

- bar A = `locked`, bar B = `circulating + unsweptFees`
- `=` becomes `≥`
- chip reads `Backed 100.1%` when `drift ≥ 0`, `Paused` when `/recon` says paused
- default: show the whole figures (they are already public on-chain), not just the percent

## Work items

### 1. Shared codec — `packages/common/src/recon-snapshot.ts` (new)

Pure, no I/O, so both writer and reader agree and the spike can assert it.

```ts
export const RECON_SNAPSHOT_KEY = (chain: string) => `recon:snapshot:${chain}`;
export interface ReconSnapshot {
  chain: string;
  lockedMilliViz: bigint; circulatingMilliViz: bigint;
  unsweptFeesMilliViz: bigint; driftMilliViz: bigint;
  status: "OK" | "UNDER_BACKED";
  checkedAt: number; // ms epoch
}
export function serializeReconSnapshot(s: ReconSnapshot): string;   // bigint -> string
export function parseReconSnapshot(json: string | null): ReconSnapshot | null; // null on malformed
```

`parse` must never throw (malformed/absent KV → `null`) and must tolerate unknown fields.
Export from `packages/common/src/index.ts`.

### 2. Recon writes the snapshot — `packages/recon/src/checker.ts`

In `check()`, after `drift`/`ok` are computed and **after** the existing `store.pause()`
call on the under-backed path (a KV write must never delay a pause):

```ts
try {
  await this.store.setState(
    RECON_SNAPSHOT_KEY(this.chain ?? "ALL"),
    serializeReconSnapshot({ ...figures, status: ok ? "OK" : "UNDER_BACKED", checkedAt: Date.now() }),
  );
} catch (err) { console.warn("[recon] snapshot write failed:", err); }
```

Rules:
- **Only definitive results are written.** An indeterminate check (`return null`, the
  early returns at `checker.ts:91,105`) leaves the previous snapshot in place — the site
  must never display a number recon itself refused to trust. Staleness is conveyed by
  `checkedAt`, not by a fresh-looking wrong value. This mirrors the PR #111/#122 rule.
- Sanity-floor and over-sweep pauses also return before the write — same reasoning.
- The write is best-effort: a failing store must not change `check()`'s return value.

### 3. `GET /recon` on the coordinator — `packages/coordinator/src/index.ts`

Next to `/health` (`index.ts:160-181`):

```jsonc
{
  "ok": true,
  "paused": false,
  "chains": {
    "GRAM": { "lockedMilliViz": 43547500, "circulatingMilliViz": 43500000,
              "unsweptFeesMilliViz": 0, "driftMilliViz": 47500,
              "status": "OK", "checkedAt": 1754300000000 }
  }
}
```

- bigints serialized as **numbers in mVIZ**, matching `serializeFees` (`/fees`); max VIZ
  supply is far under 2^53
- `chains` is a map so adding `SOLANA` later is additive, not a shape break; read the
  `GRAM` + `SOLANA` keys and include only those present
- no snapshot yet (fresh boot) → **200 with `chains: {}`**, never 404 — a 404 reads as
  "endpoint missing" and the site can't distinguish it from a bad deploy
- `cache-control: max-age=15`; strict origin echo via `corsHeadersFor`
- add `/recon` to the existing `OPTIONS` preflight condition at `index.ts:170`

### 4. Site — pure math in `site/recon-format.mjs` (new)

Mirrors `site/token-format.mjs`: browser + Node, no I/O, null ⇒ caller hides the row.

- `parseReconPayload(json, chain)` → normalized figures or `null`
- `expectedLocked(circulating, unswept)`
- `backingPct(locked, expected)` → `100.1`, `null` when `expected <= 0`
- `meterFills(locked, expected)` → `{a, b}` percentages against
  `max(locked, expected)`, so the larger bar is full and the other is proportional;
  floor the smaller at ~2% so a tiny non-zero value stays visible
- `formatViz(milliViz)` → whole VIZ, thousands separators
- `formatAgo(checkedAt, now)` → `"12s ago"` / `"3m ago"`; `null` past a staleness cutoff
  (5 × recon interval) so the card can gray out instead of implying live data

### 5. Site — wiring

- `site/index.html`: value slots in each `.meter .lab`; ids on the status chip, the `=`
  glyph and a new "as of" line in `.recon-foot`; `role="progressbar"` +
  `aria-valuenow/valuetext` on each `.track`; load `<script type="module" src="./recon.js">`
  beside `token.js`
- `site/recon.js` (new): one `fetch(CONFIG.rpc.coordinator + "/recon")`, fail-soft like
  `token.js` — on error/empty **do nothing** and leave the existing decorative bars, per
  the "hide rather than show an inflated fallback" rule
- `site/site.css`: `.meter.live .fill { animation: none; transition: width .6s }`
  (the JS adds `.live` only once real widths are set), a `.status.paused` variant, and a
  stale/gray state; the `prefers-reduced-motion` block at `site.css:850` already kills
  the sweep and must keep working
- `site/index.html:242` security copy says recon "proves that the VIZ locked equals the
  wVIZ in circulation" — soften to "fully backs" now that unequal bars are visible

## Tests

| Tier | File | Covers |
| --- | --- | --- |
| unit | `packages/common/test/recon-snapshot.test.ts` (new) | codec round-trip, malformed → `null`, unknown fields, bigint↔number bounds |
| unit | `packages/recon/test/snapshot.test.ts` (new) | OK writes correct figures; under-backed writes `UNDER_BACKED` **and** still pauses; indeterminate does **not** overwrite; throwing `setState` doesn't alter `check()`'s return |
| unit | `packages/coordinator/test/http.routes.test.ts` (extend) | `/recon` shape, CORS echo, cache header, empty-snapshot 200, `OPTIONS` 204 |
| verify | `tools/recon-meters-spike.cjs` (new, add to `npm run verify`) | `recon-format.mjs` math + fail-soft, incl. the over-backed case (`locked > expected` ⇒ a=100, b<100, pct>100) |

Fake-store/fake-remote patterns to copy: `packages/recon/test/over-sweep.test.ts`,
`packages/recon/test/backing-read-indeterminate.test.ts`. Route-test harness pattern:
`packages/coordinator/test/http.routes.test.ts`.

## Deploy

`kamal deploy -c config/deploy.coordinator.yml` — one deploy covers both the new route
and the site (baked into the coordinator image, not Pages). Signers are untouched; op-3
is not on this path. Verify with `curl https://gateway.viz.cx/recon` and confirm the
figures match the recon container log line for the same tick.

Note: the same-origin copy at gateway.viz.cx needs no CORS; the `viz-cx.github.io` copy
does, and that origin is already in the allowed list.
