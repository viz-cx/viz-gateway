# Decision — wVIZ explorer "ownership" / immutability presentation

**Date:** 2026-07-08
**Status:** DECIDED
**Applies to:** the wVIZ Jetton minter on TON (and the wVIZ SPL mint on Solana, Phase 2).

## Question

Can wVIZ show in explorers (Tonviewer et al.) as **"no owner" / immutable / final**
*while still being mintable* on every peg-in?

## Answer: no — and we should not fake it

Explorers derive the owner display and the **`Mintable: true/false`** flag directly
from the minter's on-chain `admin_address` (via `get_jetton_data`):

- `admin` = a real address → explorer shows an **owner** and **Mintable: true**.
- `admin` = `addr_none` (null) → explorer shows **no owner / immutable / Mintable:
  false**, and *every* admin-gated op (`mint#21`, `change_content#4`,
  `change_admin#3`) fails **permanently** thereafter.

On our standard governed minter (`contracts/ton/src/minter.ts`) — and on the
USDT-style governance minter (`admin_address` + `next_admin_address`) — **mint is
gated on that same admin field.** So nulling the admin to obtain the "no owner"
display permanently disables minting. The two states are mutually exclusive on any
standard-compatible contract.

The *only* way to literally show "no owner" while retaining mint is a **custom
minter** that presents `admin = addr_none` while checking a **separate, hidden
mint-authority slot**. This is exactly the pattern TON safety tooling flags as
**misleading / rug-pull-shaped**: it makes a token look supply-locked when it isn't.
For a bridge token whose entire premise is honest, auditable minting on peg-in,
shipping that would damage trust and risk wVIZ being flagged as a scam. Rejected.

## What we do instead (achieves the real goal: trustworthy explorer presentation)

1. **Minter admin = the 2-of-3 (→ 5-of-7) multisig.** Already the plan
   (`docs/plan-mainnet-deploy.md` Phase 3: deploy minter → `set-minter-admin` to the
   multisig). The explorer then shows control is a **multisig, not a single wallet** —
   the honest, verifiable "no single owner." wVIZ stays mintable (that is the peg).
2. **Verified-assets listing.** Submit wVIZ to Tonkeeper's
   [`ton-assets`](https://github.com/tonkeeper/ton-assets) registry to get the
   **verified checkmark, proper name/logo**, and to clear "unverified" warnings in
   Tonkeeper/Tonviewer. This is off-chain and **orthogonal to the admin field** — it
   works with a live, mintable token. Draft entry:
   `metadata/ton-assets.wVIZ.yaml` (fill the mainnet minter address after Phase 3).
3. **Correct on-chain metadata baked at deploy.** `WVIZ_IMAGE` defaults to the wVIZ
   avatar and the whole content cell is set at `deploy:minter`; post-handoff edits go
   through the multisig via `set:minter-content`. (See `config.ts`, `setMinterContent.ts`.)

## Token identity (2026-07-08)

Display **name = `VIZ`**, ticker/symbol = **`wVIZ`** (unchanged). Defaults updated in
`contracts/ton/src/config.ts`, `contracts/solana/src/config.ts`, and the canonical
`metadata/wviz.json`.

## If we ever genuinely want immutability

Only after the gateway is **fully decommissioned** (all wVIZ burned/redeemed, peg
retired) does renouncing admin make sense. At that point `change_admin#3 → addr_none`
(via the multisig) is the correct, honest "final" action. The tooling already exists
(`contracts/ton/src/setMinterAdmin.ts` / `changeAdminBody`). Do **not** do this while
the peg is live.
