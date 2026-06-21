import { Address, beginCell, Cell } from "@ton/core";

/**
 * Jetton minter helpers for the STANDARD governed minter layout
 * (ton-blockchain/token-contract / minter-contract). The recommended
 * stablecoin-contract has a slightly different storage (it carries a
 * `next_admin` field) and different op codes — if you deploy that one, supply
 * the init data via JETTON_MINTER_DATA_BOC (built by its own wrapper) and use
 * its change_admin op. These helpers are convenience for the standard minter
 * and for testnet bring-up.
 *
 * Validate any data builder here against the actual deployed contract before
 * mainnet — wrong storage layout produces a wrong address / broken contract.
 */

// Standard governed-minter op codes.
export const OP_MINT = 21;
export const OP_CHANGE_ADMIN = 3;
export const OP_CHANGE_CONTENT = 4;

/** storage: total_supply:Coins admin:MsgAddress content:^Cell wallet_code:^Cell */
export function buildStandardMinterData(
  admin: Address,
  content: Cell,
  jettonWalletCode: Cell,
): Cell {
  return beginCell()
    .storeCoins(0) // total_supply starts at 0
    .storeAddress(admin)
    .storeRef(content)
    .storeRef(jettonWalletCode)
    .endCell();
}

/** change_admin#3 query_id:uint64 new_admin:MsgAddress */
export function changeAdminBody(newAdmin: Address, queryId: bigint = 0n): Cell {
  return beginCell()
    .storeUint(OP_CHANGE_ADMIN, 32)
    .storeUint(queryId, 64)
    .storeAddress(newAdmin)
    .endCell();
}
