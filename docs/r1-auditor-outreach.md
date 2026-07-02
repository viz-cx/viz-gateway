# R-1 — Auditor selection & outreach

Companion to [`AUDIT.md`](./AUDIT.md). This is decision-support for **commissioning** the
external audit (the last open mainnet gate), not repo logic. Prepared 2026-07-02.

## Framing (shapes firm choice)

The audit surface is a **cross-chain custody protocol, not a large contract.** On-chain
code is tiny: a ~40-line burn-only Anchor program (`gateway_deposit`) + upstream-audited
TON contracts (`multisig-contract-v2`, `token-contract`, cell hashes pinned in
`contracts/ton/boc/PROVENANCE.md`). The real risk lives in the **off-chain TypeScript
orchestration** (canonical digest, threshold accumulation, F2 source-validation,
idempotency/crash-windows) and the **custom rotation crypto**. Pick a firm strong at
*adversarial bridge / cross-chain protocol* review, not a Solidity-DeFi shop. VIZ/Graphene
expertise is effectively nonexistent in the market — `AUDIT.md` is what closes that gap
for whoever is hired.

## Shortlist (ranked by fit)

| Firm | Why it fits | Watch-out |
|---|---|---|
| **Zellic** | Best fit — explicit cross-chain/bridge + custody specialization, offensive "try to break it" style. Matches the actual risk (cross-chain state + off-chain messaging). | Younger firm (2021); shorter track record. |
| **OtterSec** | Deepest Solana/Anchor bench (Wormhole, Solana core, Token-2022). Strong on PDA-validation pitfalls — directly relevant to T5. | Top-tier queue/price; longer lead time. |
| **Halborn** | Full-stack: can cover the off-chain backend + APIs + infra alongside the program — matches the "off-chain orchestration is the risk" reality. | Broader/less boutique; confirm the Rust+bridge lead. |
| **Beosin** | Direct Solana **bridge** audit history (Ronin, SonicSVM). Good bridge-specific checklist. | Less Western brand recognition. |

**TON:** a *full* TON contract audit is likely overkill — BOCs are upstream-audited with
pinned provenance. What needs review is **integration + provenance verification + the
on-chain approve flow**, which the bridge auditor above can cover. For belt-and-suspenders
on the contracts, **Hacken** is the most explicitly TON/FunC-capable.

**Optional complement:** **Certora** formal verification on the Anchor program's burn-only
invariant (T5: no path moves funds except burn) — high-assurance add-on used alongside a
manual audit, not instead.

## Engagement shape

- **Scope to quote:** whole-system per `AUDIT.md` §3 — off-chain orchestration (primary),
  Anchor program, VIZ rotation semantics, TON integration/provenance. Hand `AUDIT.md` as
  the RFP scope doc.
- **Budget:** complex cross-chain custody → realistically **$40k–$100k+** (not a $10k
  token audit).
- **Timeline:** **4–12 week** booking queue at top firms; **2–4 week** engagement. Start
  outreach early because of the queue.
- **Vetting ask:** sample bridge report + post-audit-exploit record (cross-ref
  Rekt.news), and confirm the *named lead* knows Anchor PDAs + off-chain bridge logic.
- **Before start:** re-pin the exact commit hash with the auditor.

## Outreach RFP (fill the brackets)

> **Subject: Audit RFP — VIZ↔TON/Solana multisig bridge (cross-chain custody)**
>
> Hi [firm],
>
> We're commissioning an independent security audit of **viz-gateway**, a federated
> M-of-N multisig bridge locking native VIZ (a Graphene chain) and minting/burning wrapped
> VIZ on TON and Solana. We're pre-mainnet; this audit is our final gate before real value.
>
> **Scope (whole-system):** the trust-critical surface is our *off-chain orchestration* —
> canonical action encoding/digest, threshold signature accumulation, per-signer
> independent source re-validation, idempotency/crash-window handling — plus a small
> burn-only Solana Anchor program (`gateway_deposit`, PDA-based deposit custody, no
> transfer path), VIZ active-set rotation via `account_update`, and TON multisig-v2
> integration (upstream contracts, pinned provenance). ~10 TypeScript packages + one
> Anchor program.
>
> We have prepared a **full audit handoff package** (system overview, trust model,
> threat-model claims T1–T8, component-by-component surface with file pointers, build/repro,
> known risks) — happy to share under NDA. Codebase is [private repo, ~X kLOC],
> commit-pinned. Tests are deterministic offline fixtures (`npm run verify`).
>
> Could you share: (1) availability / earliest start, (2) estimated effort + cost for this
> scope, (3) a representative cross-chain/bridge report, and (4) the lead auditor's Anchor
> + bridge background? Under NDA we'll send the package and grant read access.
>
> Thanks,
> [name / org / contact]

## Sources

- <https://sherlock.xyz/post/top-10-best-smart-contract-auditing-companies-in-2026>
- <https://www.adevarlabs.com/blog/top-6-solana-smart-contract-audit-firms-in-2026>
- <https://beosin.com/resources/solana-cross-chain-protocol-analysis-and-security-audit-key-points>
- <https://hacken.io/services/blockchain-security/ton-smart-contract-audit/>
