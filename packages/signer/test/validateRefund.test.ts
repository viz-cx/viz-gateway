import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegIn, GatewayAccounts, type CanonicalAction, type VizDeposit } from "@gateway/common";
import { SourceMismatchError, validateAction, type SourceValidatorDeps } from "../src/sourceValidator";

// Regression guard for the coordinator↔signer REFUND contract. PR #87 changed the dispatcher
// to spawn a PEG_IN refund of `gross − refundFee` (anti-spam) but did NOT update the signer's
// validateRefund, which kept requiring the full gross — so every peg-in refund was unsignable
// (a live 45_000 mVIZ GRAM peg-in latched a REFUND retry loop: "REFUND amount 40000 != deposit
// gross 45000"). The signer now mirrors the dispatcher (and validateGramReturn): exact
// `gross − refundFee`, with a non-positive-net dust refusal. This file is the missing test.

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

function makeGramDeposit(gross: bigint, trxId = "tx1"): VizDeposit {
  return {
    trxId,
    opIndex: 0,
    blockNum: 100,
    from: "user",
    to: "gram.gate",
    amountMilliViz: gross,
    remoteChain: "GRAM",
    remoteDestination: "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j",
    destinationValid: true,
  };
}

function makeDeps(deposit: VizDeposit): SourceValidatorDeps {
  return {
    vizChain: {
      async getDeposit(trxId, opIndex) {
        if (trxId === deposit.trxId && opIndex === deposit.opIndex) return deposit;
        return null;
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
}

function makeRefundAction(deposit: VizDeposit, amountMilliViz: bigint): CanonicalAction {
  const parent = canonicalPegIn(deposit);
  return {
    // Dispatch is by id suffix (":refund"), never the direction; REFUND is not in the
    // CanonicalAction Direction union (see validateFeeSweep's identical cast).
    direction: "REFUND" as CanonicalAction["direction"],
    id: `${parent.id}:refund`,
    remoteChain: deposit.remoteChain,
    recipient: deposit.from, // back to the VIZ sender
    amountMilliViz,
    digest: `${parent.digest}:refund`,
  };
}

// The live incident: a 45_000 mVIZ GRAM peg-in refunds gross − 5_000 fee = 40_000.
const GROSS = 45_000n;
const NET = GROSS - FEES.refundFeeMilliViz; // 40_000n

test("accepts a refund to sender for gross − fee (the dispatcher-spawned amount)", async () => {
  const deposit = makeGramDeposit(GROSS);
  await assert.doesNotReject(() => validateAction(makeRefundAction(deposit, NET), makeDeps(deposit)));
});

test("REFUSES the full gross (fee not deducted) — the exact #87 regression", async () => {
  const deposit = makeGramDeposit(GROSS);
  await assert.rejects(() => validateAction(makeRefundAction(deposit, GROSS), makeDeps(deposit)), SourceMismatchError);
});

test("REFUSES 1 mVIZ off the net (exact match, no band)", async () => {
  const deposit = makeGramDeposit(GROSS);
  await assert.rejects(() => validateAction(makeRefundAction(deposit, NET + 1n), makeDeps(deposit)), SourceMismatchError);
  await assert.rejects(() => validateAction(makeRefundAction(deposit, NET - 1n), makeDeps(deposit)), SourceMismatchError);
});

test("REFUSES a wrong recipient (not the deposit sender)", async () => {
  const deposit = makeGramDeposit(GROSS);
  await assert.rejects(
    () => validateAction({ ...makeRefundAction(deposit, NET), recipient: "attacker" }, makeDeps(deposit)),
    SourceMismatchError,
  );
});

test("REFUSES a digest not bound to the parent peg-in", async () => {
  const deposit = makeGramDeposit(GROSS);
  await assert.rejects(
    () => validateAction({ ...makeRefundAction(deposit, NET), digest: "forged:refund" }, makeDeps(deposit)),
    SourceMismatchError,
  );
});

test("REFUSES a dust refund where gross <= refund fee (net <= 0 — retained, never refunded)", async () => {
  // Defense-in-depth vs a coordinator crafting a zero/negative-value refund for a sub-fee deposit
  // the dispatcher's dust rule should have retained. Otherwise valid: correct recipient + digest.
  const deposit = makeGramDeposit(FEES.refundFeeMilliViz); // gross == fee -> net 0
  await assert.rejects(() => validateAction(makeRefundAction(deposit, 0n), makeDeps(deposit)), SourceMismatchError);
});

test("REFUSES when the parent deposit is not found on the operator's own node (getDeposit -> null)", async () => {
  const deposit = makeGramDeposit(GROSS);
  const action = makeRefundAction(deposit, NET);
  // Deps whose node has never seen this deposit -> fail-closed liveness stall.
  const missingDeps = makeDeps(makeGramDeposit(GROSS, "other-tx"));
  await assert.rejects(() => validateAction(action, missingDeps), SourceMismatchError);
});
