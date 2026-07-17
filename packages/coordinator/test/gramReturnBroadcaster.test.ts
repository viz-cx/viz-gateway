import { test } from "node:test";
import assert from "node:assert/strict";
import { GramReturnBroadcaster } from "../src/adapters";
import type { CanonicalAction, GramMintProposal } from "@gateway/common";

const action: CanonicalAction = {
  direction: "GRAM_RETURN", id: "e".repeat(64) + ":return", remoteChain: "GRAM",
  recipient: "EQ" + "B".repeat(46), amountMilliViz: 95000n, digest: "d:return",
};

function stubChain() {
  return {
    returnOrderHashFor: (_to: string, amt: bigint) => `hash-${amt}`,
    nextOrderAddress: async () => ({ orderAddr: "EQorder", seqno: "7" }),
    orderExecuted: async () => true,
  };
}
function memStore() {
  const rows = new Map<string, { txid?: string }>();
  return {
    get: async (id: string) => rows.get(id) ?? null,
    setStatus: async (id: string, _s: string, patch?: { txid?: string }) => {
      rows.set(id, { txid: patch?.txid });
    },
  };
}

test("buildProposal pins the order address, sets net amount + hash, fee 0", async () => {
  const store = memStore();
  const b = new GramReturnBroadcaster(stubChain() as any, store as any);
  const { proposal, feeMilliViz } = await b.buildProposal(action);
  const p = proposal as GramMintProposal;
  assert.equal(feeMilliViz, 0n);
  assert.equal(p.toAddress, action.recipient);
  assert.equal(p.amountMilliViz, "95000");
  assert.equal(p.orderHashHex, "hash-95000");
  assert.equal(p.orderAddr, "EQorder");
  assert.equal((await store.get(action.id))!.txid, "EQorder"); // pinned before approvals
});

test("broadcast returns the pinned order address once executed", async () => {
  const store = memStore();
  const b = new GramReturnBroadcaster(stubChain() as any, store as any);
  const { proposal } = await b.buildProposal(action);
  assert.equal(await b.broadcast(action, proposal, []), "EQorder");
});
