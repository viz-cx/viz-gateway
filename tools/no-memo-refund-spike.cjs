// SPIKE: auto-return of no-memo / invalid-destination peg-ins (offline, end-to-end over the
// REAL store + canonical + dispatcher policy).
//
// Incident 2026-07-15: a 2000-VIZ transfer to gram.gate with an EMPTY memo was silently dropped
// by the watcher and stranded, over-backing the gateway. This proves the fix: such a deposit is
// no longer dropped — it is reconstructed (destinationValid=false), enqueued HELD, and routed
// straight to an auto-refund back to the original sender. Traces the full lifecycle:
//
//   invalid-destination deposit
//     -> watcher enqueues HELD("INVALID_DESTINATION")   (never QUEUED, never mint-active)
//     -> dispatcher spawns the :refund child + parent -> REFUNDING
//     -> REFUND delivers gross back to the sender
//     -> parent -> REFUNDED
//
// Asserts: refund recipient = sender, amount = GROSS, child id/digest bound to the parent,
// idempotent re-drive, never mint-active on any chain, and cross-operator digest determinism
// (two independent reads of a destination-less deposit derive the identical refund child).
//
// Run (after `npm run build`): node tools/no-memo-refund-spike.cjs
const assert = require("node:assert");
const { canonicalPegIn, isValidRemoteAddress, createStore } = require("@gateway/common");
const { planChildren } = require("../packages/dispatcher/dist/policy");

const REFUND_CTX = { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n };

// Mirror the ONE line the viz-watcher reader uses to canonicalize a destination memo:
// a valid address passes through; anything else collapses to the "" sentinel.
const canonicalizeDest = (chain, raw) => (isValidRemoteAddress(chain, raw) ? raw : "");

(async () => {
  // ---- fixture: the incident deposit (2000 VIZ, empty memo, id -> gram.gate) -----------------
  const CHAIN = "GRAM";
  const SENDER = "id";
  const GROSS = 2_000_000n; // 2000 VIZ
  const TRX = "3fb76dc9a71731b98c408d934434a471298cafd1";

  // The reader reconstructs a destination-less deposit instead of dropping it.
  const rawMemo = ""; // empty memo — the incident
  assert.strictEqual(isValidRemoteAddress(CHAIN, rawMemo), false, "empty memo must be an invalid destination");
  const dep = {
    trxId: TRX,
    opIndex: 0,
    blockNum: 81_664_757,
    from: SENDER,
    to: "gram.gate",
    amountMilliViz: GROSS,
    remoteChain: CHAIN,
    remoteDestination: canonicalizeDest(CHAIN, rawMemo), // "" sentinel
    destinationValid: isValidRemoteAddress(CHAIN, rawMemo), // false
  };
  const action = canonicalPegIn(dep);
  assert.strictEqual(dep.destinationValid, false);
  assert.strictEqual(action.recipient, "", "destination-less action canonicalizes recipient to ''");
  console.log("[reader] no-memo deposit reconstructed (destinationValid=false, recipient='') OK");

  // ---- watcher: enqueue as HELD("INVALID_DESTINATION"), skipping caps ------------------------
  const store = createStore("memory:");
  const first = await store.enqueue({
    id: action.id,
    direction: "PEG_IN",
    remoteChain: action.remoteChain,
    recipient: action.recipient,
    sender: dep.from,
    amountMilliViz: action.amountMilliViz,
    digest: action.digest,
    status: "HELD",
    lastError: "INVALID_DESTINATION",
  });
  assert.strictEqual(first, true, "first enqueue inserts");
  let parent = await store.get(action.id);
  assert.strictEqual(parent.status, "HELD");
  assert.strictEqual(parent.lastError, "INVALID_DESTINATION", "marker persisted atomically with the insert");
  assert.strictEqual(parent.sender, SENDER);
  console.log("[watcher] deposit enqueued HELD(INVALID_DESTINATION) OK");

  // A HELD deposit is NEVER mint-active — it can't count against backing (recon unaffected).
  assert.deepStrictEqual(await store.activeRemoteChains(), [], "HELD peg-in must not mark a chain mint-active");

  // ---- dispatcher: route HELD(INVALID_DESTINATION) -> REFUNDING + :refund child --------------
  const routeRefunds = async () => {
    for (const rec of await store.due(Date.now(), ["HELD"])) {
      if (rec.direction !== "PEG_IN" || rec.lastError !== "INVALID_DESTINATION" || !rec.sender) continue;
      const children = planChildren(rec, "REFUNDING", REFUND_CTX);
      for (const child of children) await store.enqueue(child);
      await store.setStatus(rec.id, "REFUNDING");
    }
  };
  await routeRefunds();

  const child = await store.get(`${action.id}:refund`);
  assert.ok(child, "a :refund child was spawned");
  assert.strictEqual(child.direction, "REFUND");
  assert.strictEqual(child.recipient, SENDER, "refund returns to the original sender");
  assert.strictEqual(child.amountMilliViz, GROSS, "refund returns the GROSS deposit (no fee)");
  assert.strictEqual(child.digest, `${action.digest}:refund`, "child digest bound to the parent PEG_IN");
  assert.strictEqual(child.parentId, action.id, "child parentId points at the PEG_IN");
  assert.strictEqual(child.status, "QUEUED");
  parent = await store.get(action.id);
  assert.strictEqual(parent.status, "REFUNDING", "parent flipped to REFUNDING");
  console.log("[dispatcher] HELD(INVALID_DESTINATION) -> REFUNDING + REFUND(sender, gross) OK");

  // Idempotent re-drive: running the branch again must NOT double-spawn (enqueue dedupes on id,
  // and the REFUNDING parent no longer matches the HELD query).
  await routeRefunds();
  const rowCount = (await store.due(Date.now(), ["QUEUED", "REFUNDING", "REFUNDED", "HELD", "CONFIRMED"])).length;
  assert.strictEqual(rowCount, 2, "exactly two rows (parent + single refund child) after re-drive");
  console.log("[dispatcher] re-drive is idempotent (no duplicate refund) OK");

  // ---- REFUND delivers, close out the parent (mirrors dispatcher index.ts REFUNDING->REFUNDED)
  await store.setStatus(child.id, "CONFIRMED", { txid: "vizrefundtxid" });
  const done = await store.get(child.id);
  const closeParent = done.parentId ?? (done.id.endsWith(":refund") ? done.id.slice(0, -":refund".length) : null);
  await store.setStatus(closeParent, "REFUNDED");
  parent = await store.get(action.id);
  assert.strictEqual(parent.status, "REFUNDED", "parent PEG_IN closed as REFUNDED after the refund confirms");
  assert.deepStrictEqual(await store.activeRemoteChains(), [], "still never mint-active through the whole lifecycle");
  console.log("[close-out] REFUND CONFIRMED -> parent REFUNDED OK");
  await store.close();

  // ---- digest determinism: independent reads / distinct invalid memos all agree --------------
  // Two operators each read the SAME destination-less deposit off their OWN node: identical
  // refund child id + digest, so their signatures aggregate. And ANY invalid memo (empty, wrong
  // shape, colon-bearing) canonicalizes to the same "" sentinel -> the same digest, so a typo'd
  // address refunds exactly like a missing one.
  const readAs = (raw) => {
    const d = { ...dep, remoteDestination: canonicalizeDest(CHAIN, raw), destinationValid: isValidRemoteAddress(CHAIN, raw) };
    const a = canonicalPegIn(d);
    return { childId: `${a.id}:refund`, childDigest: `${a.digest}:refund` };
  };
  const opA = readAs("");
  const opB = readAs(""); // independent second read, same event
  assert.deepStrictEqual(opA, opB, "two independent reads derive the identical refund child");
  for (const badMemo of ["not-an-address", "EQtooShort", "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j:trailing"]) {
    assert.strictEqual(isValidRemoteAddress(CHAIN, badMemo), false, `"${badMemo}" is invalid`);
    assert.deepStrictEqual(readAs(badMemo), opA, `invalid memo "${badMemo}" refunds identically to no-memo`);
  }
  // Sanity: a VALID address does NOT collapse to the sentinel (so real peg-ins are untouched).
  assert.strictEqual(canonicalizeDest(CHAIN, "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j"), "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j");
  console.log("[determinism] independent reads + all invalid memos derive one canonical refund OK");

  console.log("\nRESULT: no-memo / invalid-destination peg-ins auto-return the GROSS deposit to the");
  console.log("original sender (HELD -> REFUNDING -> REFUND -> REFUNDED), idempotently, never minting");
  console.log("and never marking a chain mint-active; every operator derives the identical refund.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
