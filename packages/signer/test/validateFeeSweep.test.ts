import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegIn, GatewayAccounts, pegInFeePolicyFor, baseFee, type CanonicalAction, type VizDeposit } from "@gateway/common";
import { SourceMismatchError, validateAction, type SourceValidatorDeps } from "../src/sourceValidator";

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

const GRAM_FLOOR = pegInFeePolicyFor(FEES, "GRAM").floorMilliViz; // 45_000n
const SOLANA_FLOOR = pegInFeePolicyFor(FEES, "SOLANA").floorMilliViz; // 10_000n

const accounts = new GatewayAccounts({ SOLANA: "solana.gate", GRAM: "gram.gate" });

// Floor-dominated gross: bps% = 1_000_000 * 20 / 10000 = 2000 < GRAM floor (45000)
const FLOOR_DOMINATED_GROSS = 1_000_000n;
// bps-dominated gross: bps% = 10_000_000_000 * 20 / 10000 = 20_000_000 >> both floors
const BPS_DOMINATED_GROSS = 10_000_000_000n;

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

function makeSolanaDeposit(gross: bigint, trxId = "tx2"): VizDeposit {
  return {
    trxId,
    opIndex: 0,
    blockNum: 200,
    from: "user",
    to: "solana.gate",
    amountMilliViz: gross,
    remoteChain: "SOLANA",
    remoteDestination: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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

function makeFeeSweepAction(deposit: VizDeposit, amountMilliViz: bigint) {
  const parent = canonicalPegIn(deposit);
  return {
    direction: "FEE_SWEEP" as CanonicalAction["direction"],
    id: `${parent.id}:fee`,
    remoteChain: deposit.remoteChain,
    recipient: "fees.gate",
    amountMilliViz,
    digest: `${parent.digest}:fee`,
  };
}

// ---------------------------------------------------------------------------
// GRAM: static-floor sweep (correct post-static-config behaviour)
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: static-floor sweep (45000) accepted for floor-dominated peg-in", async () => {
  const deposit = makeGramDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, GRAM_FLOOR); // 45_000n
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

// ---------------------------------------------------------------------------
// GRAM: bps-dominated — floor is irrelevant
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: bps-dominated peg-in — bps% sweep accepted", async () => {
  const deposit = makeGramDeposit(BPS_DOMINATED_GROSS);
  const bpsFee = baseFee(BPS_DOMINATED_GROSS, pegInFeePolicyFor(FEES, "GRAM"));
  const action = makeFeeSweepAction(deposit, bpsFee);
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

// ---------------------------------------------------------------------------
// GRAM: sweep 1 mVIZ over floor is rejected (exact match)
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: sweep 1 mVIZ over static floor is rejected", async () => {
  const deposit = makeGramDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, GRAM_FLOOR + 1n);
  await assert.rejects(
    () => validateAction(action, makeDeps(deposit)),
    SourceMismatchError,
  );
});

// ---------------------------------------------------------------------------
// SOLANA: still uses static floor
// ---------------------------------------------------------------------------

test("validateFeeSweep SOLANA: static-floor sweep accepted (SOLANA policy unchanged)", async () => {
  const deposit = makeSolanaDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, SOLANA_FLOOR); // 10_000n
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

test("validateFeeSweep SOLANA: sweep below floor rejected", async () => {
  const deposit = makeSolanaDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, SOLANA_FLOOR - 1n);
  await assert.rejects(
    () => validateAction(action, makeDeps(deposit)),
    SourceMismatchError,
  );
});
