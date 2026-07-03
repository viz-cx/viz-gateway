# Compiled BOC provenance

The code cells (`*.code.boc`) are **committed** so the offline proofs
(`npm run verify`) run in CI; they are reproducible build artifacts pinned by the
sha256 + cell hashes below, so anyone can rebuild byte-identical cells and verify
what was deployed. Deployment-specific data cells (`*.data.boc`) stay gitignored.

Rebuild: clone each repo at the pinned commit, `npm install --ignore-scripts`,
`npx blueprint build --all`, then take `build/<Contract>.compiled.json` `.hex`
(that hex IS the code-cell BOC — `Buffer.from(hex,"hex")` → `.boc`).

## Code cells

### multisig.code.boc — `Multisig`
- Repo: https://github.com/ton-blockchain/multisig-contract-v2
- Commit: `9a4b13df6345c9c4068ca725e434b40f9ea5ca28` (matches the vendored wrappers in `../src/wrappers`)
- sha256   : `be6d1b18285ec8d94b831626805c1fb21a01b34b12b547f3175ceae1098ff159`
- cell hash : `d3d14da9a627f0ec3533341829762af92b9540b21bf03665fac09c2b46eabbac`

### order.code.boc — `Order` (multisig-v2 per-order contract)
- Repo: https://github.com/ton-blockchain/multisig-contract-v2
- Commit: `9a4b13df6345c9c4068ca725e434b40f9ea5ca28` (same as the multisig above)
- Source: committed `build/Order.compiled.json` `.hex` at that commit
- sha256   : `7783b8b1b4e1beec9e9f5727b1daf7bbeca6f6bcaf58e05e09c744cdb23107d1`
- cell hash : `6305a8061c856c2ccf05dcb0df5815c71475870567cab5f049e340bcf59251f3`
- NOTE: the multisig deploys each order with this code as a **library reference** (an
  exotic cell holding only this hash — see the single type-2 cell inside
  `multisig.code.boc`). The cell hash above IS that library hash; the TVM resolves it
  from the masterchain library collection on-chain, and from `blockchain.libs` in the
  `@ton/sandbox` proof (`tools/ton-onchain-approval-spike.cjs`).

### minter.code.boc — `JettonMinter` (standard governed, discoverable)
- Repo: https://github.com/ton-blockchain/token-contract
- Commit: `1182ad99413242f09925d50e70ccb7e0e09f94d4`
- Source: `ft/jetton-minter-discoverable.fc` (via `wrappers/JettonMinter.compile.ts`)
- Verified: `op::mint()=21`, `op::internal_transfer()=0x178d4519`, `op==3` change_admin,
  storage `total_supply admin content jetton_wallet_code` — matches `packages/ton-watcher/src/tonChain.ts`
  and `contracts/ton/src/{minter,setMinterAdmin}.ts`.
- sha256   : `38ec373763baf63a8a93dca030ab0acac7a989b8e9790c83deb40a15833c6387`
- cell hash : `0571976c63ec1b7550230a2609dbedb36e1b64ef8d022a16b34ea57063185b2f`

### wallet.code.boc — `JettonWallet`
- Repo/commit: same as minter (token-contract @ `1182ad9`)
- Source: `ft/jetton-wallet.fc`
- sha256   : `6b65cde3aca93550fd428ecaf8a3a52286c810bff51246d42562c8534bc3bdc0`
- cell hash : `a760d629d5343e76d045017d9dc216fc8a307a8377815feb2b0a5c490e733486`

> NOTE: the earlier RUNBOOK draft referenced `stablecoin-contract` for the minter.
> That contract's storage (`+transfer_admin`, swapped refs) and two-step admin
> handoff do **not** match our code (op 21 mint, single-step `change_admin=3`).
> The correct source is `token-contract` above.

## Data cells (deployment-specific, not code)

### multisig.data.boc — 1-of-1 testnet bootstrap init data
- Built via `../src/wrappers/Multisig.ts::multisigConfigToCell`
- `{ threshold: 1, signers: [<signer WalletV4>], proposers: [], allowArbitrarySeqno: false }`
- Signer / deployer WalletV4 (wc0): `EQDyPBoVwQLyUGjWdetwoVMdw9-aP0BkyvbWZAdONbfNdKDb`
- sha256   : `da56b6f8f20cf2a4c921ff846a0ea046bec4d227a134271c6692780938e4458d`
- cell hash : `79eed0294a56fb5a57731c0c210c032252a535477c4cb23805922071c130d58d`

## Deployed (TON testnet, 2026-07-01)

| Contract | Address |
|---|---|
| Multisig (1-of-1) | `EQAAT5z3d9RQYAoEMcNbvniJWxnMS5zrriVmCtRWUbTFFRlJ` |
| wVIZ Jetton minter | `EQDtadChfr01tTZb3DIgBTww9b4w3Ejxja1VNh5sAx3gKEW7` |
| Gateway jetton wallet (multisig-owned) | `EQDcktQd-hXf_s0qaubJoBi2RsSYf_Y9GoW9TbHFM78X0AOa` |
| Signer / deployer wallet | `EQDyPBoVwQLyUGjWdetwoVMdw9-aP0BkyvbWZAdONbfNdKDb` |

Minter admin was handed to the multisig (`change_admin`, op 3) — only the multisig
can mint/burn wVIZ.
