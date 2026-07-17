/**
 * Task 3.4: Signer validates proposal.from === accountFor(action.remoteChain)
 *
 * Three tests:
 * 1. FEE_SWEEP with wrong action.remoteChain (GRAM when parent deposit is SOLANA) → SourceMismatchError
 * 2. signVizRelease with proposal.from = "gram.gate" but action.remoteChain = "SOLANA" → throws (from-account mismatch)
 * 3. signVizRelease with proposal.from = "solana.gate" (correct) → does NOT throw from-account error
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { GatewayAccounts, type VizDeposit } from "@gateway/common";
import { SourceMismatchError, validateAction, type SourceValidatorDeps } from "../src/sourceValidator";
import { KeyedSigner, DISABLED_SOURCE_VALIDATION } from "../src/keyedSigner";
import type { VizReleaseProposal, CanonicalAction } from "@gateway/common";

// Canonical accounts for tests
const accounts = new GatewayAccounts({
  SOLANA: "solana.gate",
  GRAM: "gram.gate",
});

// Minimal fee config matching GatewayFeeConfig
const FEES = {
  floorMilliViz: 1000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 500n, GRAM: 500n },
  mintGasFloorMilliViz: { SOLANA: 100n, GRAM: 100n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.5,
  minVizPerTon: 100,
  maxVizPerTon: 20000,
  refundFeeMilliViz: 5000n,
};

// ---- Test 1: FEE_SWEEP wrong remoteChain ----------------------------------

test("FEE_SWEEP with action.remoteChain=GRAM but parent deposit remoteChain=SOLANA → SourceMismatchError", async () => {
  // Parent PEG_IN deposit at solana.gate → SOLANA
  const parentDeposit: VizDeposit = {
    trxId: "abc123",
    opIndex: 0,
    blockNum: 100,
    from: "sender1",
    to: "solana.gate",
    amountMilliViz: 100000n,
    remoteChain: "SOLANA",
    remoteDestination: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    destinationValid: true,
  };

  // FEE_SWEEP action but coordinator claims GRAM (wrong chain)
  const feeSweepAction: CanonicalAction = {
    direction: "FEE_SWEEP" as CanonicalAction["direction"],
    id: "abc123:0:fee",
    recipient: "fees.gate",
    amountMilliViz: 1000n, // will be overridden by real check
    digest: "abc123:0:fee-digest",
    remoteChain: "GRAM", // MISMATCH — parent is SOLANA
  };

  const deps: SourceValidatorDeps = {
    vizChain: {
      async getDeposit(trxId: string, opIndex: number) {
        if (trxId === "abc123" && opIndex === 0) return parentDeposit;
        return null;
      },
      async accountExists() { return false; },
    },
    solanaChain: {
      async getBurn() { return null; },
    },
    tonChain: {
      async getBurn() { return null; },
    },
    store: {
      async depositAddressBy() { return undefined; },
    },
    depositProgramId: "",
    fees: FEES,
    feesGateAccount: "fees.gate",
    accounts,
  };

  await assert.rejects(
    () => validateAction(feeSweepAction, deps),
    (err: Error) => {
      assert.ok(err instanceof SourceMismatchError, `Expected SourceMismatchError, got ${err.constructor.name}: ${err.message}`);
      assert.ok(
        err.message.includes("GRAM") && err.message.includes("SOLANA"),
        `Error should mention both chains, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---- Test 2: signVizRelease from-account mismatch -------------------------

test("signVizRelease with proposal.from=gram.gate but action.remoteChain=SOLANA → throws (from-account mismatch)", async () => {
  const action: CanonicalAction = {
    direction: "PEG_OUT",
    id: "5xKhGvQD2FNZqPPSQ5gkjN4YzUJwtcHWW3PLhPHQr2q7HcEi9r7cL5FdQkm8eFZf3Gp4jVkNqXdYrW", // looks like Solana sig
    recipient: "viz-user",
    amountMilliViz: 5000n,
    digest: "some-digest",
    remoteChain: "SOLANA",
  };

  const wrongProposal: VizReleaseProposal = {
    refBlockNum: 1000,
    refBlockPrefix: 42,
    expiration: "2030-01-01T00:00:00",
    from: "gram.gate",   // WRONG: should be solana.gate for SOLANA chain
    to: "viz-user",
    amount: "5.000 VIZ",
    memo: action.id,
  };

  const signer = new KeyedSigner(
    "op1",
    "", // empty WIF — signing will fail, but from-check runs first
    "",
    FEES,
    null,
    DISABLED_SOURCE_VALIDATION,
    null,
    null,
    accounts,
  );

  await assert.rejects(
    () => signer.signVizRelease(action, wrongProposal),
    (err: Error) => {
      assert.ok(
        err.message.includes("backing account") || err.message.includes("from"),
        `Expected from-account error, got: ${err.message}`,
      );
      assert.ok(
        err.message.includes("gram.gate") || err.message.includes("solana.gate"),
        `Error should mention account names, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---- Test 3: signVizRelease correct from-account --------------------------

test("signVizRelease with proposal.from=solana.gate and action.remoteChain=SOLANA → passes from-account check (may fail on WIF)", async () => {
  const action: CanonicalAction = {
    direction: "PEG_OUT",
    id: "5xKhGvQD2FNZqPPSQ5gkjN4YzUJwtcHWW3PLhPHQr2q7HcEi9r7cL5FdQkm8eFZf3Gp4jVkNqXdYrW",
    recipient: "viz-user",
    amountMilliViz: 5000n,
    digest: "some-digest",
    remoteChain: "SOLANA",
  };

  const correctProposal: VizReleaseProposal = {
    refBlockNum: 1000,
    refBlockPrefix: 42,
    expiration: "2030-01-01T00:00:00",
    from: "solana.gate",  // CORRECT backing account for SOLANA
    to: "viz-user",
    amount: "5.000 VIZ",
    memo: action.id,
  };

  const signer = new KeyedSigner(
    "op1",
    "", // empty WIF — signing will fail AFTER from-check passes
    "",
    FEES,
    null,
    DISABLED_SOURCE_VALIDATION,
    null,
    null,
    accounts,
  );

  try {
    await signer.signVizRelease(action, correctProposal);
    // If somehow signing with empty WIF succeeded, fine
  } catch (err) {
    const e = err as Error;
    // The from-account check must NOT be the reason for failure
    assert.ok(
      !e.message.includes("backing account"),
      `Should not throw from-account error when from is correct, got: ${e.message}`,
    );
    // It's acceptable that it throws due to empty WIF or signing failure
  }
});
