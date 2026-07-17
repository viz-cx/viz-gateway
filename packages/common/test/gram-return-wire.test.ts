import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFromWire, actionToWire, type CanonicalAction } from "../src";

test("GRAM_RETURN action round-trips through wire encoding", () => {
  const a: CanonicalAction = {
    direction: "GRAM_RETURN",
    id: "a".repeat(64) + ":return",
    remoteChain: "GRAM",
    recipient: "EQ" + "A".repeat(46),
    amountMilliViz: 995000n,
    digest: "deadbeef:return",
  };
  const back = actionFromWire(actionToWire(a));
  assert.deepEqual(back, a);
});
