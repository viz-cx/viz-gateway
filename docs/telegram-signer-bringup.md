*Bring up your gateway signer (mainnet 2-of-3, TON-only launch)*

We're doing the first live mainnet smoke round-trip (small value). All on-chain pieces are already deployed — wVIZ minter, the 2-of-3 multisig (admin of the minter), and the `gram.gate` / `fees.gate` VIZ backing accounts. What's left is standing up the *federation*: one coordinator box (I run it) plus *your own signer daemon on your own machine*.

*The whole point of 2-of-3 is that your signer runs on YOUR hardware with YOUR keys and YOUR RPC nodes — never mine.* If your signer points at my nodes or I hold your keys, the multisig is fake. Please keep it independent.

*Repo:* `https://github.com/viz-cx/viz-gateway`
*You are:* `op-N` ← I'll tell you your slot (op-2 or op-3).
*You need:*
- Your *VIZ active WIF* (one of the three keys on `gram.gate`) and your *24-word TON mnemonic* (your multisig signer wallet).
- Your *own VIZ node URL* and *own toncenter (TON) API key*.
- A host the coordinator can reach on a port (behind VPN/mTLS ideally).
- Your TON signer wallet funded ~0.3–0.5 TON (on-chain propose/approve gas for peg-in mints).

---

*1. Get the code (from main):*
```
git clone https://github.com/viz-cx/viz-gateway.git
cd viz-gateway
npm ci && npm run build
```
(already have it? `git checkout main && git pull && npm ci && npm run build`)

*2. Seal your two secrets into an encrypted keystore* (so no plaintext key sits on disk):
```
export VIZ_SIGNING_WIF="<your VIZ active WIF>"
export GRAM_SIGNER_MNEMONIC="<your 24 words on one line, in quotes>"
node tools/keystore.cjs seal ./keystore.mainnet.json
unset VIZ_SIGNING_WIF GRAM_SIGNER_MNEMONIC
```
It asks for a passphrase (you'll re-enter it when the signer starts). The mnemonic *must stay inside the double quotes* or the shell splits it. `keystore.mainnet.json` is gitignored — it never leaves your machine.

*3. Create `.env.mainnet` in the repo root.* Fill in the `<...>` values; the addresses below are public and fixed — copy them verbatim:
```
SERVICE=signer
OPERATOR_ID=op-N                       # ← your slot (op-2 or op-3)
SIGNER_LISTEN=0.0.0.0:8090             # bind so I can reach /approve (put behind VPN/mTLS)
SIGNER_ADVERTISE_URL=http://<your-host>:8090   # the URL I can reach you at
COORDINATOR_URL=<coordinator URL I send you>   # e.g. http://coord-host:8080

FEDERATION_MANIFEST=./federation.json
FED_KEYSTORE=./keystore.mainnet.json
# FED_KEYSTORE_PASSPHRASE=             # leave unset → prompts on start

VIZ_NODE_URL=<YOUR OWN VIZ node>       # F2: must be yours, never mine
GRAM_ENDPOINT=<YOUR OWN toncenter URL> # F2: must be yours, never mine
GRAM_API_KEY=<your toncenter key>

# public, fixed — copy verbatim:
GRAM_JETTON_MINTER_ADDRESS=EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ
GRAM_MULTISIG_ADDRESS=EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0
GRAM_GATEWAY_JETTON_WALLET=EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy
```

⚠️ *F2 independence:* `VIZ_NODE_URL` and `GRAM_ENDPOINT` MUST be your own nodes. Your signer re-reads every peg-in/peg-out from these before signing — if they point at mine, your independent check is gone.

*4. Start your signer* (run from the repo root):
```
env $(grep -v '^#' .env.mainnet | xargs) npm run start:signer
```
Enter your keystore passphrase when prompted.

It should print:
```
[signer] operator=op-N listening on 0.0.0.0:8090 (federation 2-of-3)
```
and self-register with me within ~20s. I'll confirm on my side that `registered` climbed and I see `registered op-N -> http://<your-host>:8090`.

---

⚠️ *If you see* `registration key mismatch: this box claims OPERATOR_ID 'op-N' but its VIZ key is labeled 'op-M'` *— stop and ping me.* It means the VIZ-key↔operator labels in `federation.json` need a swap (I'll fix `OPERATOR_ID` or the manifest). It's a loud, safe failure — nothing is lost.

*Once all three signers show registered,* I'll run a tiny peg-in (VIZ → `gram.gate`) and peg-out (burn wVIZ) and we'll confirm the mint/release + recon. Then a couple of quick drills.

🔑 Never share your WIF or mnemonic — not even with me. If one box ever holds two operators' keys, the 2-of-3 is fake.
