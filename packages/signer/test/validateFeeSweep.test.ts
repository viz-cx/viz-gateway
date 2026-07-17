import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegIn, clampBand, GatewayAccounts, type CanonicalAction, type VizDeposit } from "@gateway/common";
import { SourceMismatchError, validateAction, type SourceValidatorDeps } from "../src/sourceValidator";

// Mirrors deployed defaults (minVizPerTon=100 → feeLo=9000, static floor=10000).
const FEES = {
  floorMilliViz: 10_000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 150_000n },
  mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.5,
  minVizPerTon: 100,
  maxVizPerTon: 20_000,
  refundFeeMilliViz: 5_000n,
};

// feeLo = deriveFloorMilliViz(0.06, 100, 1.5) = 9000
const FEE_LO = clampBand(FEES).feeLo; // 9_000n
const STATIC_FLOOR = FEES.floorMilliViz; // 10_000n

const accounts = new GatewayAccounts({ SOLANA: "solana.gate", GRAM: "gram.gate" });

// Floor-dominated gross: bps% = 1_000_000 * 20 / 10000 = 2000 < feeLo(9000) < static(10000)
const FLOOR_DOMINATED_GROSS = 1_000_000n;
// bps-dominated gross: bps% = 10_000_000_000 * 20 / 10000 = 20_000_000 >> 10000
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
// GRAM: feeLo-sized sweep (the correct post-fix behaviour)
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: feeLo-sized sweep accepted for floor-dominated peg-in", async () => {
  const deposit = makeGramDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, FEE_LO); // 9_000n
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

// ---------------------------------------------------------------------------
// GRAM: static-floor sweep (old bug — signer now rejects this)
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: static-floor sweep (10000) rejected for floor-dominated peg-in", async () => {
  const deposit = makeGramDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, STATIC_FLOOR); // 10_000n — old over-pull
  await assert.rejects(
    () => validateAction(action, makeDeps(deposit)),
    (err: Error) => {
      assert.ok(err instanceof SourceMismatchError);
      assert.ok(
        err.message.includes("10000") && err.message.includes("9000"),
        `Should mention both amounts, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// GRAM: bps-dominated — floor is irrelevant, both policies give same amount
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: bps-dominated peg-in — bps% sweep accepted regardless of floor", async () => {
  const deposit = makeGramDeposit(BPS_DOMINATED_GROSS);
  const bpsFee = BPS_DOMINATED_GROSS * BigInt(FEES.bps) / 10_000n; // 20_000_000n >> both floors
  const action = makeFeeSweepAction(deposit, bpsFee);
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

// ---------------------------------------------------------------------------
// GRAM: sweep exactly 1 mVIZ over feeLo is rejected (no tolerance)
// ---------------------------------------------------------------------------

test("validateFeeSweep GRAM: sweep 1 mVIZ over feeLo is rejected", async () => {
  const deposit = makeGramDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, FEE_LO + 1n);
  await assert.rejects(
    () => validateAction(action, makeDeps(deposit)),
    SourceMismatchError,
  );
});

// ---------------------------------------------------------------------------
// SOLANA: still uses static floor (sweepFeePolicyFor is identical to pegInFeePolicyFor)
// ---------------------------------------------------------------------------

test("validateFeeSweep SOLANA: static-floor sweep accepted (SOLANA policy unchanged)", async () => {
  const deposit = makeSolanaDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, STATIC_FLOOR); // 10_000n — correct for SOLANA
  await assert.doesNotReject(() => validateAction(action, makeDeps(deposit)));
});

test("validateFeeSweep SOLANA: feeLo amount (9000) rejected — SOLANA uses static floor", async () => {
  const deposit = makeSolanaDeposit(FLOOR_DOMINATED_GROSS);
  const action = makeFeeSweepAction(deposit, FEE_LO); // 9_000n — wrong for SOLANA
  await assert.rejects(
    () => validateAction(action, makeDeps(deposit)),
    SourceMismatchError,
  );
});
