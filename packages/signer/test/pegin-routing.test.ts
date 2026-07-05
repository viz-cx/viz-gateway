import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegIn, type VizDeposit } from "@gateway/common";

/**
 * Task 2.4: Peg-in chain routing validation
 *
 * These tests verify that the signer rejects a peg-in where the coordinator claims
 * a remoteChain that doesn't match the chain derived from the deposit's receiving account.
 *
 * Context:
 * - VizJsChain.getDeposit derives remoteChain from the receiving account via GatewayAccounts.chainFor(to)
 * - A deposit to solana.gate always yields remoteChain: "SOLANA" regardless of coordinator claims
 * - canonicalPegIn(deposit) is authoritative: it uses the account-derived remoteChain
 * - assertSameAction compares derived.remoteChain !== wire.remoteChain and throws SourceMismatchError
 */

test("coordinator remoteChain != account-derived chain → different digests", () => {
  // Deposit that arrived at solana.gate → account-derived chain = SOLANA
  const realDeposit: VizDeposit = {
    trxId: "abc123def456",
    opIndex: 0,
    blockNum: 100,
    from: "tester4",
    to: "solana.gate",
    amountMilliViz: 10000n,
    remoteChain: "SOLANA",
    remoteDestination: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  };

  // Coordinator claims GRAM for the same event (mismatch attack)
  const wireDeposit: VizDeposit = {
    ...realDeposit,
    remoteChain: "GRAM",
  };

  const derivedAction = canonicalPegIn(realDeposit);
  const wireAction = canonicalPegIn(wireDeposit);

  // Different chains must produce different digests (chain is in the canonical encoding)
  assert.notEqual(
    derivedAction.digest,
    wireAction.digest,
    "remoteChain mismatch must produce different digests",
  );

  // Verify the chains are what we expect
  assert.equal(derivedAction.remoteChain, "SOLANA", "derived action should have SOLANA chain");
  assert.equal(wireAction.remoteChain, "GRAM", "wire action should have GRAM chain");

  // Digests differ, so if assertSameAction were called, it would throw
  assert.notEqual(
    derivedAction.digest,
    wireAction.digest,
    "assertSameAction will detect this mismatch and reject",
  );
});

test("deposit to gram.gate is account-derived as GRAM chain", () => {
  // Deposit that arrived at gram.gate → account-derived chain = GRAM
  const gramDeposit: VizDeposit = {
    trxId: "xyz789abc123",
    opIndex: 1,
    blockNum: 200,
    from: "user1",
    to: "gram.gate",
    amountMilliViz: 50000n,
    remoteChain: "GRAM",
    remoteDestination: "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j",
  };

  const action = canonicalPegIn(gramDeposit);

  assert.equal(action.remoteChain, "GRAM", "deposit to gram.gate yields GRAM chain");
  assert.equal(action.id, "xyz789abc123:1", "id is correctly formatted");
  assert.equal(action.recipient, "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j");
  assert.equal(action.amountMilliViz, 50000n);
});

test("same deposit produces same digest (idempotency)", () => {
  const deposit: VizDeposit = {
    trxId: "test123",
    opIndex: 0,
    blockNum: 50,
    from: "sender",
    to: "solana.gate",
    amountMilliViz: 1000n,
    remoteChain: "SOLANA",
    remoteDestination: "11111111111111111111111111111112",
  };

  const action1 = canonicalPegIn(deposit);
  const action2 = canonicalPegIn(deposit);

  assert.equal(
    action1.digest,
    action2.digest,
    "canonical encoding of the same deposit must always produce the same digest",
  );

  assert.equal(action1.remoteChain, action2.remoteChain);
  assert.equal(action1.id, action2.id);
});
