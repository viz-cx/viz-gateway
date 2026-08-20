import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  type CanonicalAction,
  type GramMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";
import { releaseTxId } from "@gateway/viz-watcher/dist/vizSign";
import { assertNotReplay, ReplayRefusalError, type ReplayLedgerDeps } from "../src/replayLedger";

const action: CanonicalAction = {
  direction: "PEG_OUT",
  id: "b".repeat(64),
  remoteChain: "GRAM",
  recipient: "alice",
  amountMilliViz: 100000n,
  digest: "d".repeat(64),
};

const EXP1 = "2026-01-01T00:00:00";
const EXP1_MS = Date.parse(`${EXP1}Z`);

function vizProposal(expiration: string): VizReleaseProposal {
  return {
    refBlockNum: 1,
    refBlockPrefix: 2,
    expiration,
    from: "gram.gate",
    to: "alice",
    amount: "100.000 VIZ",
    memo: action.id,
  };
}

function gramProposal(orderAddr: string): GramMintProposal {
  return {
    orderSeqno: "1",
    orderAddr,
    toAddress: "EQ" + "C".repeat(46),
    amountMilliViz: "100000",
    destProvisioned: true,
    orderHashHex: "e".repeat(64),
    actionId: action.id,
  };
}

function deps(over: Partial<ReplayLedgerDeps> = {}): ReplayLedgerDeps {
  return {
    store: createStore("memory:"),
    headBlockTimeMs: async () => EXP1_MS - 30_000, // prior proposal still live by default
    releaseLanded: async () => false,
    ...over,
  };
}

test("first approval claims the key and passes; identical proposal passes again", async () => {
  const d = deps();
  await assertNotReplay(action, vizProposal(EXP1), d);
  await assertNotReplay(action, vizProposal(EXP1), d); // crash-retry with identical bytes
  const row = await d.store.getSignedProposal(action.id);
  assert.equal(row?.key, `viz-tx:${releaseTxId(vizProposal(EXP1))}`);
  assert.equal(row?.expiresAtMs, EXP1_MS);
});

test("a second DIFFERENT viz proposal is refused while the first is still live", async () => {
  const d = deps();
  await assertNotReplay(action, vizProposal(EXP1), d);
  await assert.rejects(
    assertNotReplay(action, vizProposal("2026-01-01T00:00:30"), d),
    ReplayRefusalError,
  );
});

test("a different viz proposal is refused FOREVER once the first release landed", async () => {
  const d = deps({
    headBlockTimeMs: async () => EXP1_MS + 120_000, // well past expiry + margin
    releaseLanded: async (txid) => txid === releaseTxId(vizProposal(EXP1)),
  });
  await assertNotReplay(action, vizProposal(EXP1), d);
  await assert.rejects(
    assertNotReplay(action, vizProposal("2026-01-01T00:00:30"), d),
    /ALREADY LANDED/,
  );
});

test("a different viz proposal is allowed once the first is expired and never landed", async () => {
  const d = deps({ headBlockTimeMs: async () => EXP1_MS + 120_000 });
  await assertNotReplay(action, vizProposal(EXP1), d);
  const p2 = vizProposal("2026-01-01T00:00:30");
  await assertNotReplay(action, p2, d); // legit expired-retry rebuilt with fresh TaPoS
  assert.equal((await d.store.getSignedProposal(action.id))?.key, `viz-tx:${releaseTxId(p2)}`);
});

test("margin: expired but within the visibility margin is still refused", async () => {
  const d = deps({ headBlockTimeMs: async () => EXP1_MS + 30_000 }); // < 60s margin
  await assertNotReplay(action, vizProposal(EXP1), d);
  await assert.rejects(assertNotReplay(action, vizProposal("2026-01-01T00:00:30"), d), /still live/);
});

test("GRAM: same orderAddr passes (re-drive), different orderAddr refused unconditionally", async () => {
  const d = deps({ headBlockTimeMs: async () => Number.MAX_SAFE_INTEGER });
  const addr = "EQ" + "D".repeat(46);
  await assertNotReplay(action, gramProposal(addr), d);
  await assertNotReplay(action, gramProposal(addr), d);
  await assert.rejects(assertNotReplay(action, gramProposal("EQ" + "F".repeat(46)), d), ReplayRefusalError);
});

test("cross-shape swap (viz-signed action re-asked as GRAM order) is refused", async () => {
  const d = deps();
  await assertNotReplay(action, vizProposal(EXP1), d);
  await assert.rejects(assertNotReplay(action, gramProposal("EQ" + "D".repeat(46)), d), ReplayRefusalError);
});

test("unparseable proposal expiration is refused", async () => {
  await assert.rejects(assertNotReplay(action, vizProposal("garbage"), deps()), ReplayRefusalError);
});

for (const url of ["memory:", "sqlite::memory:"]) {
  test(`store CAS semantics (${url})`, async () => {
    const store = createStore(url);
    assert.equal(await store.putSignedProposal("a1", "k1", 5, null), true);
    assert.equal(await store.putSignedProposal("a1", "k2", 6, null), false); // first-claim lost
    assert.equal(await store.putSignedProposal("a1", "k2", 6, "wrong"), false); // CAS mismatch
    assert.equal(await store.putSignedProposal("a1", "k2", 6, "k1"), true); // CAS hit
    assert.deepEqual(await store.getSignedProposal("a1"), { key: "k2", expiresAtMs: 6 });
    assert.equal(await store.getSignedProposal("nope"), null);
    await store.close();
  });
}
