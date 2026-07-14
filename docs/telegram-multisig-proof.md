*Approve mainnet multisig liveness-proof order (2-of-3)*

We're proving the mainnet 2-of-3 gateway multisig can propose → approve → execute *before* we hand it the wVIZ minter admin (that step is one-way, so we verify the multisig works first).

I (op-1) submitted a *benign* test order — it just sends *0.02 TON back to op-1*, nothing else — and approved it (1/2). We need *one more signer* to reach the threshold and auto-execute.

*Repo:* `https://github.com/viz-cx/viz-gateway`
*Order:* `EQBv4Rcf-2Esf_bJQW-Qtc0AqgbL9AMzsUtFI_ppIJqjeghm`
*You need:* your operator wallet funded with ~0.1 TON (approval gas).

*1. Get the tools (from main):*
```
git clone https://github.com/viz-cx/viz-gateway.git
cd viz-gateway
npm install && npm run build
```
(already have it? `git checkout main && git pull`)

*2. Create your `.env.mainnet` in the repo root.* This is the SAME file you'll use for the real gateway run — the proof tool reads the same variable names, so nothing is throwaway:
```
GRAM_ENDPOINT=https://toncenter.com/api/v2/jsonRPC
GRAM_API_KEY=
GRAM_SIGNER_MNEMONIC="word1 word2 word3 ... word24"
ORDER_ADDRESS=EQBv4Rcf-2Esf_bJQW-Qtc0AqgbL9AMzsUtFI_ppIJqjeghm
```
The mnemonic *must stay inside the double quotes* (all 24 words on one line) or the shell splits it. `.env.mainnet` is gitignored, so it never leaves your machine. (`GRAM_API_KEY` optional — add a toncenter key to avoid rate limits. `ORDER_ADDRESS` is only for this proof; the real run doesn't need it.)

*3. DRY-RUN first — review what you're signing (does NOT broadcast):*
```
set -a; . ./.env.mainnet; set +a; node tools/multisig-proof-approve.cjs
```

It must print:
```
[0] send_message  mode=1  value=0.02 TON  -> EQAng1IaiIZDo0GFu7htyU-UZx-IPDHzC_YRObfoCui15kDk
```
plus your index (`op idx 1` = op-2, `op idx 2` = op-3).

⚠️ *If it shows anything other than "0.02 TON → EQAng1…", do NOT approve — ping me.*

*4. Broadcast the approval (same, with `SEND=1`):*
```
set -a; . ./.env.mainnet; set +a; SEND=1 node tools/multisig-proof-approve.cjs
```

It auto-executes the moment your approval lands (2/2). Ping me when done and I'll confirm on-chain.

⏳ The order expires ~1 hour after submission — if you miss the window, tell me and I'll re-issue a fresh one (new address; just update `ORDER_ADDRESS`).
🔑 Never share your mnemonic.
