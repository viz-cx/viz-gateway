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
