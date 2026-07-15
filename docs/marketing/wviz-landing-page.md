# Landing page copy — wVIZ gateway

_Web copy for viz.cx / viz.world. Sections map to page blocks. Addresses, fees, and links are live mainnet values; only `{{APP_LINK}}` (bridge app URL) and `{{USER_GUIDE_LINK}}` (where the guide is published) remain to be filled._

---

## Hero

**Headline:** VIZ, now on TON.

**Subhead:** Move your VIZ onto TON as **wVIZ** and back again — 1:1, backed, and
redeemable any time. Hold VIZ in Tonkeeper and use it across the TON ecosystem.

**Primary CTA:** Bridge now → `{{APP_LINK}}`
**Secondary CTA:** Read the guide → `{{USER_GUIDE_LINK}}`

---

## Value props (three cards)

**1:1, always redeemable**
Every wVIZ is backed by real VIZ locked in the gateway. Convert back to VIZ whenever
you like — peg-out is free.

**Secured by many, not one**
An independent operator federation. Funds move only when the operators independently
agree — no single party, and no single server, can move them. An automatic watchdog
reconciles the backing and pauses on any mismatch.

**Built for TON**
wVIZ is a standard Jetton. Hold it in Tonkeeper, trade it, and plug into TON dApps —
no special wallet required.

---

## How it works

### Peg-in — VIZ → wVIZ

1. **Send VIZ** to `gram.gate`.
2. **Add your TON address** in the memo.
3. **Receive wVIZ** in your TON wallet in ~40 seconds.

### Peg-out — wVIZ → VIZ

1. **Send wVIZ** to `EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy`.
2. **Add your VIZ account name** in the comment.
3. **Receive VIZ** back — free, in seconds.

> Tip: always copy-paste addresses, and start with a small test amount if it's your
> first time.

---

## Security

The gateway is run by an independent **operator federation**. Each operator
verifies every transfer against the blockchain on their own infrastructure and signs
only the exact action they can reproduce — so no single operator, and no single
server, can move your funds. The coordinating service holds **no keys** at all.

A separate **reconciliation process** continuously proves that the VIZ locked in the
gateway equals the wVIZ in circulation. On any discrepancy, it **pauses the entire
system** until operators resolve it. The gateway is open source — audit it yourself:
`https://github.com/viz-cx/viz-gateway`.

---

## Fees & limits

| | Peg-in (VIZ → wVIZ) | Peg-out (wVIZ → VIZ) |
|---|---|---|
| Fee | `max(10 VIZ, 0.20%)` | Free |
| First-time surcharge | `10 VIZ` (once per TON wallet) | — |
| Minimum | ~21 VIZ (first peg-in), ~11 VIZ after — just enough to cover the fee | None |
| Rate | 1:1 (minus fee) | 1:1 |

The fee is charged in VIZ so the 1:1 backing is never diluted.

---

## FAQ

**What is wVIZ?**
Wrapped VIZ — VIZ represented as a Jetton on TON. 1 wVIZ = 1 VIZ, 3 decimals, fully
backed.

**Can I always get my VIZ back?**
Yes. Peg-out is free and available any time; wVIZ is always redeemable 1:1.

**How long does bridging take?**
Peg-in: ~40s plus the mint. Peg-out: a few seconds plus the release — usually under a
minute.

**Which wallets do I need?**
Any VIZ wallet, and any TON wallet that supports Jettons (e.g. Tonkeeper).

**What if I get the memo wrong?**
A peg-in with an empty or invalid memo is skipped, not sent to a random address. Copy
-paste your address, and test with a small amount first.

**Is it safe?**
No single party can move funds (independent operator federation, keyless coordinator),
and the backing is continuously reconciled with an automatic pause on any mismatch.

---

## Footer

- [viz.cx](https://viz.cx) · [viz.world](https://viz.world)
- [Telegram: viz_world](https://t.me/viz_world) · [Telegram: viz_cx](https://t.me/viz_cx)
- [User guide]({{USER_GUIDE_LINK}}) · [Source code](https://github.com/viz-cx/viz-gateway)
- wVIZ token address: `EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ`
