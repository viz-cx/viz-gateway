# Landing page copy — wVIZ gateway

_Web copy for viz.cx / viz.world. Sections map to page blocks. Placeholders `{{...}}` filled at launch._

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
A 5-of-7 operator federation. Funds move only when a supermajority independently
agrees. An automatic watchdog reconciles the backing and pauses on any mismatch.

**Built for TON**
wVIZ is a standard Jetton. Hold it in Tonkeeper, trade it, and plug into TON dApps —
no special wallet required.

---

## How it works

### Peg-in — VIZ → wVIZ

1. **Send VIZ** to `{{GRAM_GATE_ACCOUNT}}`.
2. **Add your TON address** in the memo.
3. **Receive wVIZ** in your TON wallet in ~40 seconds.

### Peg-out — wVIZ → VIZ

1. **Send wVIZ** to `{{GATEWAY_JETTON_WALLET}}`.
2. **Add your VIZ account name** in the comment.
3. **Receive VIZ** back — free, in seconds.

> Tip: always copy-paste addresses, and start with a small test amount if it's your
> first time.

---

## Security

The gateway is run by an independent **5-of-7 operator federation**. Each operator
verifies every transfer against the blockchain on their own infrastructure and signs
only the exact action they can reproduce — so no single operator, and no single
server, can move your funds. The coordinating service holds **no keys** at all.

A separate **reconciliation process** continuously proves that the VIZ locked in the
gateway equals the wVIZ in circulation. On any discrepancy, it **pauses the entire
system** until operators resolve it. The gateway is open source — audit it yourself:
`{{REPO_LINK}}`.

---

## Fees & limits

| | Peg-in (VIZ → wVIZ) | Peg-out (wVIZ → VIZ) |
|---|---|---|
| Fee | `max({{FEE_FLOOR}} VIZ, {{FEE_RATE}})` | Free |
| First-time surcharge | `{{ACTIVATION_SURCHARGE}} VIZ` (once per TON wallet) | — |
| Minimum | {{MIN_PEGIN}} VIZ | None |
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
No single party can move funds (5-of-7 federation, keyless coordinator), and the
backing is continuously reconciled with an automatic pause on any mismatch.

---

## Footer

- [viz.cx]({{WEBSITE_VIZ_CX}}) · [viz.world]({{WEBSITE_VIZ_WORLD}})
- [Telegram: viz_world]({{TELEGRAM_VIZ_WORLD}}) · [Telegram: viz_cx]({{TELEGRAM_VIZ_CX}})
- [User guide]({{USER_GUIDE_LINK}}) · [Source code]({{REPO_LINK}})
- wVIZ token address: `{{WVIZ_MINTER_ADDRESS}}`
