# Phase B — TON on-chain M-of-N approval routing (design)

**Status:** IMPLEMENTED 2026-07-03. Trust-boundary wiring done: the coordinator is
keyless on TON; operators propose/approve on-chain from their own wallets; the
offline 3-of-5 sandbox proof is green in `npm run verify`. What remains is the
LIVE 3-of-5 testnet proof (operational — see RUNBOOK §9b) and the deferred
`action.id`-in-order idempotency embed (belt-and-suspenders; the single-designated-
proposer + persist-before-propose guard covers the crash window today).
Authored 2026-07-03 against `main` = `551912a`.
**Parent plan:** `docs/plan-nof-m-federation.md` §Phase B (this doc resolves its open
design decisions and is the implementation spec).

## Problem (verified against code, not re-derived)

TON is today a **fake M-of-N**. The path:

- `coordinator/index.ts:31-40` constructs `GramHttpChain` **with `cfg.gram.signerMnemonic`**.
- `GramMintBroadcaster.broadcast()` (`adapters.ts:107`) → `GramHttpChain.submitMint(proposal, signatures)`.
- `submitMint` (`tonChain.ts:218`) signs `new_order` with `this.signerMnemonic`,
  sends it with `approve_on_init=true`, and **ignores the `signatures` array**
  (docstring `tonChain.ts:205-216`).

Consequences:
1. The **keyless coordinator holds a TON key** and mints solo — violates the trust
   model VIZ/Solana uphold (coordinator holds nothing that can act on-chain).
2. Signer approvals (`approveGramMint` → ed25519 over the order hash) are **theater**:
   the contract never sees them. TON executes 1-of-1 regardless of `threshold`.

**Key-split (parent §1) and approval-routing (parent §2) are one change:** the
coordinator's only way to act on TON is `submitMint`-with-key, so the key cannot be
removed without changing *how* the order is created and approved.

## Multisig-v2 mechanics (confirmed from vendored wrappers)

- `Multisig.sendNewOrder(sender, actions, expiration, value, addrIdx, isSigner, seqno)`
  — `sender` is a real wallet (signs the message). The multisig deploys an `Order`
  at the deterministic address `getOrderAddress(seqno)`. `isSigner=true`
  (`approve_on_init`) counts the proposer's approval immediately.
- `Order.sendApprove(sender, signer_idx, ...)` — an **on-chain** message that MUST
  come from `signers[signer_idx]`'s wallet (`Order.fc` checks `via.address`; err 106
  `unauthorized_sign`). There is **no off-chain signature aggregation** in this
  contract. Approvals are on-chain side effects.
- Order executes (sends the mint to the minter) the moment `approvals_num == threshold`.
- `Order.getOrderData()` exposes `{ inited, executed, approvals[], approvals_num, threshold }`.

## Decisions

1. **Self-submit approvals** (not relay-of-pre-signed). Each operator's signer process
   sends its own approve from its own TON wallet key, over its own TON node. This is
   the only option consistent with "each key stays in its own process; the coordinator
   holds nothing that can act." Relay-of-pre-signed would require operators to hand
   signed wallet-external messages (with pinned wallet seqno) to the coordinator —
   weakens the trust boundary and is seqno-fragile.
2. **Designate one proposer per action.** The coordinator (keyless) picks the first
   reachable operator as *proposer*; that operator's signer sends `new_order`
   (`approve_on_init=true`, its own approval). The remaining operators each send an
   on-chain `approve`. This keeps **single-proposer seqno ordering** (no double-mint
   from two operators grabbing different seqnos) while making approvals genuinely
   multi-party. The coordinator still drives; it just can no longer sign.
3. **`approve()` returns a receipt, not bytes.** For TON the signer's approval result
   is `{ actionId, operatorId, signature: "<receipt>" }` where the receipt encodes the
   on-chain effect (order address + signer index + approve tx hash). The orchestrator's
   threshold accounting (`ApprovalSet`) is unchanged — it counts distinct operators.
4. **`broadcast()` becomes "confirm executed."** No combined tx to submit; the order
   executes on-chain once threshold approvals land. `broadcast` polls `getOrderData`
   until `executed` (bounded) and returns the order address as the txid.

## New TON flow (coordinator-driven, keyless)

```
buildProposal(action):
  - destProvisioned, NET, orderSeqno (nextOrderSeqno), orderAddr = f(multisig, seqno)
  - build the mint ORDER cell (mint action -> minter), embedding action.id (idempotency)
  - proposal = { orderSeqno, orderAddr, toAddress, amountMilliViz(NET),
                 destProvisioned, orderHashHex = <real order cell hash>, actionId }

orchestrator.process:
  for signer in signers:            # coordinator drives, holds no key
    receipt = signer.approve(action, proposal)   # ON-CHAIN side effect + receipt
    set.add(receipt)
    if set.isMet: break
  broadcast(...)                    # poll getOrderData until executed; return orderAddr

signer.approveGramMint(action, proposal):     # runs in the operator's own process
  - F2 validate source (unchanged) + re-derive & verify the order cell == proposal.orderHashHex
  - myIdx = index of THIS operator's wallet in multisig.signers
  - if order does not exist on-chain yet AND I am the designated proposer:
        sendNewOrder(myWallet, [mintAction], expiration, value, myIdx, isSigner=true)
    else:
        wait until order exists (proposer's new_order landed), then
        if not already approved at myIdx: order.sendApprove(myWallet, myIdx)
  - return receipt { orderAddr, myIdx, approveTxHash }
```

**Proposer selection:** the coordinator marks the first signer in its list as proposer
(deterministic). If the proposer is offline, the next reachable signer becomes proposer.
Exactly one `new_order` per action (idempotency below guarantees this across crashes).

## Idempotency under multi-proposer (parent §3)

Order address = `f(multisig, orderSeqno)` — content-independent. Two risks:

1. **Two proposers, two seqnos → two orders → double-mint.** Avoided by decision 2
   (single designated proposer). Belt-and-suspenders: the mint ORDER embeds `action.id`
   (as a text nonce in the order payload). On crash recovery the proposer scans recent
   orders for its `action.id` before creating a new one — so a proposer that crashed
   *after* `new_order` but *before* persisting the address still finds its own order
   instead of minting twice.
2. **Approve replay.** `Order` rejects a second approve from the same signer_idx (err
   107 `already_approved`); the signer also checks `getOrderData().approvals[myIdx]`
   before sending, so a re-drive is a no-op, not a second gas burn.

The existing persist-before-send in `GramMintBroadcaster` (record `orderAddr` before the
proposer sends) is retained and now paired with the `action.id`-in-order scan.

## Code changes

| File | Change |
|---|---|
| `packages/gram-watcher/src/index.ts` | Construct `GramHttpChain` **read-only** — drop `multisigAddress`/`signerMnemonic` args (already only calls read methods). |
| `packages/gram-watcher/src/gramChain.ts` | Split write path out of `submitMint`. Add: `buildMintOrderCell(proposal)` (pure, returns cell + hash, embeds action.id), `orderData(orderAddr)`, `hasApproved(orderAddr, idx)`. Keep read path. `submitMint` retired / replaced by the two operator-side calls below. |
| `packages/gram-watcher/src/gramApprove.ts` (new) | Operator-side on-chain actions: `proposeMintOrder(client, wallet, multisig, orderCell, seqno, myIdx)` (sendNewOrder) and `approveOrder(client, wallet, orderAddr, myIdx)` (Order.sendApprove). Uses the operator's own mnemonic. |
| `packages/signer/src/keyedSigner.ts` | `approveGramMint` performs the on-chain effect (propose or approve) and returns a receipt. Needs a TON write client + `isProposer` flag + multisig address (operator's own config). |
| `packages/signer/src/index.ts` | Wire the TON write client (operator's own node + mnemonic + multisig addr) into `KeyedSigner`. |
| `packages/coordinator/src/adapters.ts` | `GramMintBroadcaster.buildProposal` builds the real order cell + hash + embeds actionId; `broadcast` = poll-until-executed (no key). `HttpSignerClient` unchanged (receipt rides in `signature`). |
| `packages/coordinator/src/index.ts` | **Remove `signerMnemonic` from the coordinator's `GramHttpChain`.** Coordinator becomes truly keyless on TON. |
| `packages/common/src/types.ts` | `GramMintProposal`: add `orderAddr`, `actionId`; `orderHashHex` becomes the real order cell hash. |
| `packages/common/src/config.ts` | No new keys needed. **Implemented:** proposer = `federation.operators[0].id` (the coordinator pins it in `proposal.proposerOperatorId`; each signer computes `isProposer = proposerOperatorId === operatorId`). `GRAM_MULTISIG_ADDRESS`/`GRAM_SIGNER_MNEMONIC` already existed. Coordinator no longer *reads* `GRAM_SIGNER_MNEMONIC` (keyless). |

## Proof plan

1. **Offline sandbox proof** — `tools/gram-onchain-approval-spike.cjs` using `@ton/sandbox`
   (devDependency) + the vendored `multisig.code.boc` / `minter.code.boc` / `wallet.code.boc`.
   Deploy a real 3-of-5 multisig + minter (admin = multisig), run the flow, assert:
   - mint does NOT execute at 1 or 2 approvals (under threshold → no supply change);
   - mint executes at exactly the 3rd approval (supply increases by NET);
   - a 4th/duplicate approve is rejected (already_approved), supply unchanged;
   - an approve from a non-signer wallet is rejected (unauthorized_sign);
   - crash-recovery: re-driving after the proposer's new_order does NOT create a 2nd order.
   Add to `npm run verify`.
2. **Live testnet 3-of-5 checklist** — RUNBOOK §: deploy a fresh 3-of-5 multisig on
   testnet, fund 5 operator wallets, run 5 signer processes (one key each) + coordinator,
   drive a peg-in, prove threshold mint + crash/recovery mid-approval + signer-set
   rotation (old signers can no longer approve).

## Exit criteria (parent §Phase B)

3-of-5 TON peg-in mint completed by independent operator wallets; crash-window re-proof
green; rotation proof green. Offline sandbox proof green in `npm run verify`.
</content>
</invoke>
