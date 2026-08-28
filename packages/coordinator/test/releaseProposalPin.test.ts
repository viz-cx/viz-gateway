import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayAccounts, type CanonicalAction } from "@gateway/common";
import { VizReleaseBroadcaster } from "../src/adapters";

// Regression guard for the 2026-08-28 mainnet peg-out livelock: buildProposal rebuilt the
// VIZ release body every drive round — a fresh expiration each time, i.e. a fresh
// replay-ledger key at every signer — and with the operators' claim windows staggered the
// federation never got threshold approvals on ONE body (17 rounds, approvals always < 2).
// The broadcaster must PIN one body per action, reuse it across rounds until it nears
// expiration, and keep the pin when a broadcast attempt fails (so a retry re-sends the
// SAME body / same deterministic txid — the persist-before-send idempotency backstop).

const accounts = new GatewayAccounts({ SOLANA: "solana.gate", GRAM: "gram.gate" });
const store = { get: async () => undefined, setStatus: async () => {} };

const action: CanonicalAction = {
  direction: "PEG_OUT",
  id: "sig1",
  recipient: "alice",
  amountMilliViz: 30_000n,
  digest: "d",
  remoteChain: "SOLANA",
};

function makeChain(opts: { validityMs: number; sendFails?: boolean }) {
  let builds = 0;
  const chain = {
    async buildReleaseProposal(a: CanonicalAction, from: string) {
      builds += 1;
      return {
        refBlockNum: builds, // distinct per build, so reuse is observable
        refBlockPrefix: 42,
        expiration: new Date(Date.now() + opts.validityMs).toISOString().slice(0, 19),
        from,
        to: a.recipient,
        amount: "30.000 VIZ",
        memo: a.id,
      };
    },
    transactionId: () => "txid1",
    async broadcastRelease() {
      if (opts.sendFails) throw new Error("node down");
      return "txid1";
    },
    async confirmReleaseByTxId() {
      return null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { chain: chain as any, builds: () => builds };
}

test("reuses ONE pinned release body across drive rounds", async () => {
  const { chain, builds } = makeChain({ validityMs: 600_000 });
  const b = new VizReleaseBroadcaster(chain, accounts, store);
  const first = await b.buildProposal(action);
  const second = await b.buildProposal(action);
  const third = await b.buildProposal(action);
  assert.equal(builds(), 1, "must build the body once, not per round");
  assert.equal(second.proposal, first.proposal);
  assert.equal(third.proposal, first.proposal);
});

test("rebuilds when the pinned body nears expiration", async () => {
  // 30s validity < the 90s reuse margin, so every round must rebuild.
  const { chain, builds } = makeChain({ validityMs: 30_000 });
  const b = new VizReleaseBroadcaster(chain, accounts, store);
  await b.buildProposal(action);
  await b.buildProposal(action);
  assert.equal(builds(), 2, "a nearly-expired body must not be reused");
});

test("failed broadcast keeps the pin; successful broadcast drops it", async () => {
  const failing = makeChain({ validityMs: 600_000, sendFails: true });
  const b1 = new VizReleaseBroadcaster(failing.chain, accounts, store);
  const { proposal } = await b1.buildProposal(action);
  await assert.rejects(() => b1.broadcast(action, proposal, ["sig"]));
  const retry = await b1.buildProposal(action);
  assert.equal(retry.proposal, proposal, "retry after a failed send must reuse the same body (same txid)");

  const okChain = makeChain({ validityMs: 600_000 });
  const b2 = new VizReleaseBroadcaster(okChain.chain, accounts, store);
  const built = await b2.buildProposal(action);
  await b2.broadcast(action, built.proposal, ["sig"]);
  await b2.buildProposal(action);
  assert.equal(okChain.builds(), 2, "after a successful send the pin is dropped (fresh body next time)");
});
