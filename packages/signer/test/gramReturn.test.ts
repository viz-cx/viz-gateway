import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPegOut, type RemoteBurn, type CanonicalAction } from "@gateway/common";
import { SourceMismatchError, validateAction, type SourceValidatorDeps } from "../src/sourceValidator";

const TX = "a".repeat(64);
const burn: RemoteBurn = {
  chain: "GRAM", sourceId: TX, from: "EQ" + "B".repeat(46),
  homeDestination: "ghost", amountMilliViz: 100000n, height: 1,
};
const parent = canonicalPegOut(burn);
const returnAction: CanonicalAction = {
  direction: "GRAM_RETURN", id: `${TX}:return`, remoteChain: "GRAM",
  recipient: burn.from, amountMilliViz: 95000n, digest: `${parent.digest}:return`,
};

function deps(accountExists: boolean): SourceValidatorDeps {
  return {
    vizChain: { getDeposit: async () => null, accountExists: async () => accountExists },
    solanaChain: { getBurn: async () => null },
    tonChain: { getBurn: async (id) => (id === TX ? burn : null) },
    store: { depositAddressBy: async () => undefined },
    depositProgramId: "prog",
    fees: { refundFeeMilliViz: 5000n } as any,
    feesGateAccount: "fees.gate",
    accounts: {} as any,
  };
}

test("accepts a return to sender for gross - fee when destination does NOT exist", async () => {
  await assert.doesNotReject(validateAction(returnAction, deps(false)));
});
test("REFUSES when the destination account exists (valid peg-out, not a return)", async () => {
  await assert.rejects(validateAction(returnAction, deps(true)), SourceMismatchError);
});
test("REFUSES a wrong recipient", async () => {
  await assert.rejects(validateAction({ ...returnAction, recipient: "EQ" + "C".repeat(46) }, deps(false)), SourceMismatchError);
});
test("REFUSES a wrong amount (fee not deducted)", async () => {
  await assert.rejects(validateAction({ ...returnAction, amountMilliViz: 100000n, digest: `${parent.digest}:return` }, deps(false)), SourceMismatchError);
});
test("REFUSES a digest not bound to the parent peg-out", async () => {
  await assert.rejects(validateAction({ ...returnAction, digest: "forged:return" }, deps(false)), SourceMismatchError);
});
test("REFUSES when the parent burn is not found on the operator's own TON node (getBurn -> null)", async () => {
  // Valid-shaped tx hash, but the operator's node has never seen it (fail-closed liveness stall).
  const missing: CanonicalAction = { ...returnAction, id: `${"b".repeat(64)}:return` };
  await assert.rejects(validateAction(missing, deps(false)), SourceMismatchError);
});
test("REFUSES a malformed parentId (not a TON tx hash)", async () => {
  await assert.rejects(validateAction({ ...returnAction, id: "not-a-tx-hash:return" }, deps(false)), SourceMismatchError);
});
test("REFUSES a dust return where gross <= refund fee (net <= 0 — must be retained, never returned)", async () => {
  // Defense-in-depth vs a malicious coordinator crafting a zero/negative-value return order for a
  // sub-fee burn the dispatcher's dust rule should have retained. Otherwise fully valid: correct
  // recipient, bound digest, absent destination — only net <= 0 makes it illegitimate.
  const DUST_TX = "c".repeat(64);
  const dustBurn: RemoteBurn = {
    chain: "GRAM", sourceId: DUST_TX, from: "EQ" + "B".repeat(46),
    homeDestination: "ghost", amountMilliViz: 5000n, height: 1,
  };
  const dustParent = canonicalPegOut(dustBurn);
  const dustDeps: SourceValidatorDeps = {
    ...deps(false),
    tonChain: { getBurn: async (id) => (id === DUST_TX ? dustBurn : null) },
  };
  const dustAction: CanonicalAction = {
    direction: "GRAM_RETURN", id: `${DUST_TX}:return`, remoteChain: "GRAM",
    recipient: dustBurn.from, amountMilliViz: 0n, digest: `${dustParent.digest}:return`,
  };
  await assert.rejects(validateAction(dustAction, dustDeps), SourceMismatchError);
});
