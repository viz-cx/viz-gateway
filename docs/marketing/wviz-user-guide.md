# How to use the VIZ ↔ TON gateway (wVIZ)

The gateway lets you move **VIZ** onto **TON** as **wVIZ** — and back again — at a
1:1 rate. This guide walks you through both directions step by step.

> **Note:** addresses, fee rates, and links below are live mainnet values. Only the
> published guide URL is still a placeholder.

---

## New here? 30-second primer

- **VIZ** is the native asset of the VIZ blockchain — fast, feeless transfers with
  human-readable account names.
- **wVIZ** ("wrapped VIZ") is VIZ represented as a token (a Jetton) on **TON**. It
  lets you hold and use VIZ inside the TON ecosystem — wallets like Tonkeeper, DEXes,
  and dApps.
- **1 wVIZ is always redeemable for exactly 1 VIZ.** Every wVIZ in circulation is
  backed by real VIZ locked in the gateway. You can convert back any time.

You do **not** need to understand the machinery to use it. Send in one direction,
receive in the other.

## What you'll need

- A **VIZ wallet** you control (to send/receive VIZ).
- A **TON wallet** — e.g. [Tonkeeper](https://tonkeeper.com) — to hold and send wVIZ.
- That's it. Your TON wallet auto-creates its wVIZ token wallet the first time you
  receive wVIZ; no manual setup.

---

## Peg-in: VIZ → wVIZ (get VIZ onto TON)

You send VIZ on the VIZ chain, and receive wVIZ in your TON wallet.

### Steps

1. **Copy your TON address** from your TON wallet. It looks like
   `EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG` (starts with `EQ` or `UQ`).
2. **Send VIZ** from your VIZ wallet to the gateway account **`gram.gate`**.
3. **Put your TON address in the memo** — exactly, and nothing else.
   - ✅ `EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG`
   - ❌ empty memo, extra words, or any `:` character → the deposit is skipped.
4. **Wait ~40 seconds** for VIZ finality. The gateway then mints wVIZ to your TON
   address. First-time mints deploy your wVIZ token wallet automatically.
5. **wVIZ appears in your TON wallet.** Done.

### What you receive

You receive **wVIZ = VIZ sent − fee**. The fee is taken in VIZ at conversion time so
the 1:1 backing always holds.

- **Fee** = `max(10 VIZ, 0.20% of the amount)`.
- **First-time surcharge** = a small one-time `10 VIZ` the very
  first time your TON wallet receives wVIZ (covers deploying your token wallet). Zero
  on every peg-in after that.
- **Minimum peg-in** = there's no fixed floor — you just need to cover the fee, so
  roughly **21 VIZ your first time** (10 fee + 10 first-wallet surcharge + gas) and
  **~11 VIZ after**. Deposits too small to cover the fee are refunded, not minted.

**Worked example** — send **3,000 VIZ**, first time ever:

| Item | Amount |
|---|---|
| You send | 3,000 VIZ |
| Fee | `max(10, 0.20%)` = 10 VIZ |
| First-time surcharge | 10 VIZ |
| **You receive** | **≈ 2,980 wVIZ** |

> ⚠️ **Double-check your TON address.** The memo is where your wVIZ is sent. A wrong
> address means wVIZ goes to the wrong place. Copy-paste it — don't type it.

---

## Peg-out: wVIZ → VIZ (bring VIZ back home)

You send wVIZ on TON, and receive VIZ on the VIZ chain. **Peg-out is free.**

### Steps

1. **Know your VIZ account name** (e.g. `your-viz-account`).
2. **Send your wVIZ** from your TON wallet to the gateway's wVIZ address
   **`EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy`**.
3. **Put your VIZ account name in the comment/message** of the transfer — exactly.
   - ✅ `your-viz-account`
   - ❌ empty or a wrong name → the release can't be routed.
4. **Wait a few seconds** for TON finality, then a short moment for the gateway to
   release. The matching wVIZ is burned and VIZ lands in your VIZ account.
5. **VIZ appears in your VIZ wallet.** Done.

### What you receive

- **You receive the full amount in VIZ** — 1:1, **no fee, no minimum**.
- Release typically completes within a minute of TON finality.

> ⚠️ **Put your exact VIZ account name in the comment** — not your TON address, not a
> memo phrase. That comment is how the gateway knows where to send your VIZ.

---

## Fees & limits at a glance

| | Peg-in (VIZ → wVIZ) | Peg-out (wVIZ → VIZ) |
|---|---|---|
| **Fee** | `max(10 VIZ, 0.20%)`, taken in VIZ | **Free** |
| **First-time surcharge** | `10 VIZ` once per TON wallet | — |
| **Minimum** | ~21 VIZ first time, ~11 VIZ after | None |
| **Rate** | 1:1 (minus fee) | 1:1 |
| **Typical time** | ~40s + mint | seconds + release |
| **Where to route** | memo = your **TON address** | comment = your **VIZ account** |

---

## FAQ

**Is it safe? Who controls my funds in transit?**
No single party can. The gateway is run by an independent **operator federation** —
funds only move when the operators independently agree on the exact same action,
verified against the chain. A separate reconciliation process
continuously checks that locked VIZ equals circulating wVIZ and **auto-pauses the
whole system** on any mismatch. See the [security overview](#) for details.

**How long does it take?**
Peg-in: about 40 seconds for VIZ to finalize, then the mint. Peg-out: a few seconds
for TON to finalize, then the release — usually under a minute total.

**What decimals does wVIZ use?**
wVIZ has **3 decimals**. 1 wVIZ = 1 VIZ.

**What if I make a mistake in the memo/comment?**
Peg-in with a bad or empty memo is skipped rather than minted to a random address.
If you're unsure, start with a small test amount above the minimum. Always copy-paste
addresses.

**Can I always convert back?**
Yes. wVIZ is fully backed 1:1 and peg-out is free — redeem for VIZ any time.

**Which wallets work?**
Any VIZ wallet for the VIZ side; any TON wallet that supports Jettons (e.g. Tonkeeper)
for the wVIZ side.

---

## Links

- Website: [viz.cx](https://viz.cx) · [viz.world](https://viz.world)
- Community: [t.me/viz_world](https://t.me/viz_world) · [t.me/viz_cx](https://t.me/viz_cx)
- wVIZ token: `EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ` (verify before use)
