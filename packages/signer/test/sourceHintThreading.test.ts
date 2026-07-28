import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegIn, GatewayAccounts, type CanonicalAction, type SourceHint, type VizDeposit } from "@gateway/common";
import { validateAction, type SourceValidatorDeps } from "../src/sourceValidator";

// F2 pruned-history fix: the coordinator relays the parent PEG_IN's block number as an UNTRUSTED
// out-of-band SourceHint. These tests lock that the hint actually reaches VizChain.getDeposit's
// third argument on BOTH the PEG_IN and the REFUND(child) paths, and that a getDeposit which only
// resolves WITH the correct block hint (i.e. history is pruned) makes validation succeed only when
// the hint is supplied — exactly the stuck-refund unblock.

const FEES = {
  floorMilliViz: 10_000n,
  gramFloorMilliViz: 45_000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 37_500n },
  mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.5,
  gramVizPerTon: 500,
  refundFeeMilliViz: 5_000n,
};
const accounts = new GatewayAccounts({ SOLANA: "solana.gate", GRAM: "gram.gate" });
const BLOCK = 81976371;

const deposit: VizDeposit = {
  trxId: "779ffb0d9efc79e6d1a9bb21bf645534bb93d0f7",
  opIndex: 0,
  blockNum: BLOCK,
  from: "kristi",
  to: "gram.gate",
  amountMilliViz: 100_000n,
  remoteChain: "GRAM",
  remoteDestination: "UQCYdTLdjTjaoCuxXOSg_vArUrGshQBSipqH0rCpby_cqBEv",
  destinationValid: true,
};

/**
 * Deps whose getDeposit RECORDS the block-hint arg and, by default, models a PRUNED history:
 * it returns the deposit ONLY when the correct block hint is supplied (mirrors the live fix where
 * operation_history is gone but the block-log fallback — reached via the hint — still resolves).
 */
function makeDeps(): { deps: SourceValidatorDeps; hints: Array<number | undefined> } {
  const hints: Array<number | undefined> = [];
  const deps: SourceValidatorDeps = {
    vizChain: {
      async getDeposit(trxId, opIndex, blockNumHint) {
        hints.push(blockNumHint);
        if (trxId !== deposit.trxId || opIndex !== deposit.opIndex) return null;
        return blockNumHint === BLOCK ? deposit : null; // pruned unless the hint is present+correct
      },
      async accountExists() { return false; },
    },
    solanaChain: { async getBurn() { return null; } },
    tonChain: { async getBurn() { return null; } },
    store: { async depositAddressBy() { return undefined; } },
    depositProgramId: "",
    fees: FEES,
    feesGateAccount: "fees.gate",
    accounts,
  };
  return { deps, hints };
}

const parent = canonicalPegIn(deposit);
const refundAction: CanonicalAction = {
  direction: "REFUND" as CanonicalAction["direction"],
  id: `${parent.id}:refund`,
  remoteChain: "GRAM",
  recipient: deposit.from,
  amountMilliViz: deposit.amountMilliViz - FEES.refundFeeMilliViz,
  digest: `${parent.digest}:refund`,
};
const hint: SourceHint = { sourceBlockNum: BLOCK };

test("REFUND re-read: the block hint reaches getDeposit and unblocks a pruned parent", async () => {
  const { deps, hints } = makeDeps();
  await assert.doesNotReject(() => validateAction(refundAction, deps, hint));
  assert.deepEqual(hints, [BLOCK], "getDeposit must receive the relayed block hint");
});

test("REFUND re-read WITHOUT the hint stays fail-closed (pruned parent -> null -> refuse)", async () => {
  const { deps, hints } = makeDeps();
  await assert.rejects(() => validateAction(refundAction, deps), /not found or not yet irreversible/);
  assert.deepEqual(hints, [undefined], "no hint threaded when none is supplied");
});

test("PEG_IN re-read: the block hint reaches getDeposit and validates the mint", async () => {
  const { deps, hints } = makeDeps();
  await assert.doesNotReject(() => validateAction(parent, deps, hint));
  assert.deepEqual(hints, [BLOCK]);
});

test("a WRONG hint does not resolve the pruned parent (untrusted: own-node lookup fails closed)", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => validateAction(refundAction, deps, { sourceBlockNum: 42 }), /not found or not yet irreversible/);
});
