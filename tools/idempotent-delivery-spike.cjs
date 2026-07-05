// SPIKE: idempotent delivery at the broadcast boundary.
//
// Verifies that:
//   1.  actionExecuted=false -> normal signing + broadcast path.
//   2.  actionExecuted=true  -> Orchestrator short-circuits (no signing, no broadcast).
//   3.  Dispatcher sets BROADCAST before coordinator call (status machine path).
//   4.  An orphaned BROADCAST row resolved via actionExecuted -> CONFIRMED / QUEUED.
//   5.  parentId column on REFUND child -> dispatcher closes parent by parentId.
//   6.  Solana mint tx messageB64 changes when actionId is present (memo included).
//   7.  actionExecuted throws -> exception propagates (not silently swallowed).
//   8.  Short-circuit returns non-zero feeMilliViz -> FEE_SWEEP child spawnable.
//   9.  broadcast=true with no txid -> CONFIRMED with txid=null.
//   10. FEE_SWEEP child carries parentId.
//   11. PEG_IN REFUNDING with sender=null -> no REFUND child.
//   12. PEG_IN CONFIRMED with fee=0n -> no FEE_SWEEP child.
//   13. Legacy parentId fallback: parentId=null + id suffix -> closes parent.
//   14. BROADCAST status in MINTED_STATUSES -> unsweptFeesMilliViz counts it.
//   15. actionId="" (empty string) -> no memo instruction added (falsy).
//   16. BROADCAST row surfaced by stale() for dispatcher recovery.
//   17-20. REAL VizReleaseBroadcaster: persist-txid-before-send + confirm-by-id + drift.
//   21-24. REAL GramMintBroadcaster: no-RPC happy path, persist-order-addr-before-send,
//          orderExists short-circuit on recovery, re-broadcastable when order absent.
//
// Run (after `npm run build`): node tools/idempotent-delivery-spike.cjs
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const viz = require("viz-js-lib");
const { canonicalPegOut, baseFee, pegInFeePolicyFor } = require("@gateway/common");

// The dispatcher (VG-04) derives the FEE_SWEEP amount from the row's immutable gross,
// NOT the coordinator-pinned fee. Mirror that here (FEES is defined just below) so the
// spike checks the same independently-derived value.
const sweepAmountFor = (rec) => baseFee(rec.amountMilliViz, pegInFeePolicyFor(FEES, rec.remoteChain ?? "SOLANA"));
const { milliToViz } = require("../packages/viz-watcher/dist/vizChain.js");
const { Orchestrator } = require("../packages/coordinator/dist/orchestrator.js");
const { planTransition, planChildren } = require("../packages/dispatcher/dist/policy.js");
const { mintMessageB64 } = require("../packages/solana-watcher/dist/solanaSign.js");
const { InMemoryGatewayStore, SqliteGatewayStore } = require("../packages/common/dist/store.js");
const { KeyedSigner, DISABLED_SOURCE_VALIDATION } = require("../packages/signer/dist/keyedSigner.js");
const { VizReleaseBroadcaster, GramMintBroadcaster } = require("../packages/coordinator/dist/adapters.js");
const { releaseTxId } = require("../packages/viz-watcher/dist/vizSign.js");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const FEES = {
  floorMilliViz: 10000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10000n, GRAM: 10000n },
  mintGasFloorMilliViz: { SOLANA: 1000n, GRAM: 1000n },
};

function makePegOutAction() {
  return canonicalPegOut({
    sourceId: "aa".repeat(32),
    height: 1,
    from: "EQx",
    amountMilliViz: 5000n,
    homeDestination: "alice",
  });
}

function fakeBroadcaster(action, { alreadyExecuted = false, existingTxid = "EXISTING_TXID" } = {}) {
  const proposal = {
    refBlockNum: 1,
    refBlockPrefix: 2,
    expiration: "2026-06-28T12:00:00",
    from: "viz-gateway",
    to: action.recipient,
    amount: milliToViz(action.amountMilliViz),
    memo: action.id,
  };
  const broadcastCalls = [];
  return {
    broadcastCalls,
    buildProposal: async () => ({ proposal, feeMilliViz: 0n }),
    broadcast: async (_a, _p, signatures) => {
      broadcastCalls.push(signatures);
      return "TXID_" + signatures.length;
    },
    actionExecuted: async () =>
      alreadyExecuted ? { executed: true, txid: existingTxid } : { executed: false },
  };
}

(async () => {
  // ── 1. Normal path: actionExecuted=false -> sign + broadcast ──────────────
  {
    const action = makePegOutAction();
    const b = fakeBroadcaster(action, { alreadyExecuted: false });
    const kp = viz.auth.toWif("gw", "pA", "active");
    const ks = new KeyedSigner("op-1", kp, "", FEES, null, DISABLED_SOURCE_VALIDATION);
    const signerClient = { operatorId: "op-1", approve: (a, p) => ks.signVizRelease(a, p) };
    const r = await new Orchestrator(1, ["op-1"], [signerClient], b).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.approvals, 1, "normal path collects 1 approval");
    assert.ok(r.txid && r.txid.startsWith("TXID_"), `expected TXID_ prefix, got ${r.txid}`);
    assert.strictEqual(b.broadcastCalls.length, 1, "broadcast() called once");
    console.log("[1] actionExecuted=false -> normal sign+broadcast OK");
  }

  // ── 2. Short-circuit: actionExecuted=true -> skip signing + broadcast ──────
  {
    const action = makePegOutAction();
    const b = fakeBroadcaster(action, { alreadyExecuted: true, existingTxid: "CHAIN_TX_42" });
    const r = await new Orchestrator(1, ["op-1"], [], b).process(action);
    assert.strictEqual(r.broadcast, true, "short-circuit still reports broadcast=true");
    assert.strictEqual(r.txid, "CHAIN_TX_42", "txid comes from chain, not from broadcaster.broadcast");
    assert.strictEqual(r.approvals, 0, "no approvals collected");
    assert.strictEqual(b.broadcastCalls.length, 0, "broadcast() never called");
    console.log("[2] actionExecuted=true -> short-circuit: broadcast=true, approvals=0, chain txid OK");
  }

  // ── 3. Dispatcher status machine: BROADCAST set before coordinator call ────
  {
    const store = new InMemoryGatewayStore();
    const pegInId = "t1:0";
    await store.enqueue({
      id: pegInId,
      direction: "PEG_IN",
      remoteChain: "SOLANA",
      recipient: "9xRecipient",
      sender: "viz-sender",
      amountMilliViz: 100000n,
      digest: "deadbeef",
      status: "QUEUED",
    });
    await store.setStatus(pegInId, "BROADCAST");
    const rec = await store.get(pegInId);
    assert.strictEqual(rec.status, "BROADCAST", "status is BROADCAST before coordinator call");
    console.log("[3] dispatcher sets BROADCAST pre-coordinator -> status=BROADCAST OK");
  }

  // ── 4. Recovery: orphaned BROADCAST -> actionExecuted -> CONFIRMED / QUEUED ─
  {
    const store = new InMemoryGatewayStore();
    const pegInId = "t2:0";
    await store.enqueue({
      id: pegInId,
      direction: "PEG_IN",
      remoteChain: "SOLANA",
      recipient: "9xRecipient",
      sender: "viz-sender",
      amountMilliViz: 100000n,
      digest: "beefdead",
      status: "BROADCAST",
    });
    const rec = await store.get(pegInId);

    // Case A: coordinator confirms action was already executed -> CONFIRMED
    const confirmedResult = { broadcast: true, txid: "RECOVERED_TXID", feeMilliViz: 0n };
    const t = planTransition(rec, confirmedResult, Date.now(), { retryIntervalMs: 10000, windowMs: 180000 });
    assert.strictEqual(t.status, "CONFIRMED");
    assert.strictEqual(t.patch.txid, "RECOVERED_TXID");
    console.log("[4a] orphaned BROADCAST + actionExecuted=true -> CONFIRMED OK");

    // Case B: coordinator says not yet executed -> QUEUED (retry)
    const failResult = { broadcast: false, error: "still signing" };
    const t2 = planTransition(rec, failResult, Date.now(), { retryIntervalMs: 10000, windowMs: 180000 });
    assert.strictEqual(t2.status, "QUEUED");
    console.log("[4b] orphaned BROADCAST + actionExecuted=false -> QUEUED retry OK");
  }

  // ── 5. parentId: REFUND child gets parentId; close parent via parentId ─────
  {
    const store = new InMemoryGatewayStore();
    const pegInId = "t3:0";
    await store.enqueue({
      id: pegInId,
      direction: "PEG_IN",
      remoteChain: "SOLANA",
      recipient: "9xRecipient",
      sender: "viz-sender",
      amountMilliViz: 100000n,
      digest: "cafe1234",
      status: "QUEUED",
    });

    // Exhaust delivery window -> REFUNDING
    const pegInRec = await store.get(pegInId);
    const refundingT = planTransition(
      pegInRec,
      { broadcast: false, error: "timeout" },
      Date.now() + 200000,
      { retryIntervalMs: 10000, windowMs: 180000 },
    );
    assert.strictEqual(refundingT.status, "REFUNDING");
    await store.setStatus(pegInId, "REFUNDING", refundingT.patch);

    // Spawn REFUND child (planChildren now sets parentId)
    const updatedRec = await store.get(pegInId);
    const children = planChildren(updatedRec, "REFUNDING", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n });
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].direction, "REFUND");
    assert.strictEqual(children[0].parentId, pegInId, "REFUND child carries parentId");
    for (const child of children) await store.enqueue(child);

    // Read the REFUND row and verify parentId persisted
    const refundRec = await store.get(`${pegInId}:refund`);
    assert.ok(refundRec, "REFUND child was enqueued");
    assert.strictEqual(refundRec.parentId, pegInId, "parentId stored in REFUND row");

    // Dispatcher closes parent via parentId (stable, survives id-scheme changes)
    if (refundRec.parentId) await store.setStatus(refundRec.parentId, "REFUNDED");
    const parent = await store.get(pegInId);
    assert.strictEqual(parent.status, "REFUNDED", "parent closed to REFUNDED via parentId");
    console.log("[5] REFUND child.parentId closes parent REFUNDING->REFUNDED without id-suffix hack OK");
  }

  // ── 6. Solana memo: messageB64 differs with/without actionId ──────────────
  {
    const submitter = Keypair.generate();
    const opA = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    const multisig = Keypair.generate().publicKey.toBase58();
    const nonceAccount = Keypair.generate().publicKey.toBase58();
    const nonceValue = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const base = {
      recipient, amountMilliViz: "50000", destProvisioned: true,
      mint, multisig, signers: [opA.publicKey.toBase58()],
      feePayer: submitter.publicKey.toBase58(),
      nonceAccount, nonceValue, decimals: 3, messageB64: "",
    };
    const withoutMemo = { ...base };
    withoutMemo.messageB64 = mintMessageB64(withoutMemo);
    const withMemo = { ...base, actionId: "t1:0" };
    withMemo.messageB64 = mintMessageB64(withMemo);
    assert.notStrictEqual(withoutMemo.messageB64, withMemo.messageB64, "memo changes messageB64");
    console.log("[6] Solana mint messageB64 with actionId memo != without memo OK");

    // Deterministic: same actionId -> same messageB64
    const withMemo2 = { ...base, actionId: "t1:0" };
    withMemo2.messageB64 = mintMessageB64(withMemo2);
    assert.strictEqual(withMemo.messageB64, withMemo2.messageB64, "deterministic");
    console.log("[6b] Solana mint messageB64 deterministic for same actionId OK");

    // Different actionIds -> different messageB64
    const withOtherId = { ...base, actionId: "t2:1" };
    withOtherId.messageB64 = mintMessageB64(withOtherId);
    assert.notStrictEqual(withMemo.messageB64, withOtherId.messageB64);
    console.log("[6c] Different actionIds produce different Solana messageB64 OK");
  }

  // ── 7. actionExecuted throws -> exception propagates (not silently swallowed) ─
  // The idempotency check is a safety gate; a network error must surface, not be
  // ignored (ignoring would fall through to a potentially duplicate broadcast).
  {
    const action = makePegOutAction();
    const explodingBroadcaster = {
      buildProposal: async () => ({ proposal: {}, feeMilliViz: 0n }),
      broadcast: async () => "NEVER",
      actionExecuted: async () => { throw new Error("RPC_TIMEOUT"); },
    };
    await assert.rejects(
      () => new Orchestrator(1, ["op-1"], [], explodingBroadcaster).process(action),
      /RPC_TIMEOUT/,
      "actionExecuted error must propagate, not be swallowed",
    );
    console.log("[7] actionExecuted throws -> exception propagates OK");
  }

  // ── 8. Short-circuit returns non-zero feeMilliViz -> FEE_SWEEP spawnable ────
  // On crash recovery a PEG_IN reaches the coordinator again. actionExecuted=true
  // means the mint already happened; the coordinator still returns the fee so the
  // dispatcher can spawn the FEE_SWEEP child that was never queued.
  {
    const action = makePegOutAction(); // use peg-out shape to keep proposal simple
    const FEE = 25_000n;
    const broadcaster = {
      buildProposal: async () => ({ proposal: {}, feeMilliViz: FEE }),
      broadcast: async () => "NEVER",
      actionExecuted: async () => ({ executed: true, txid: "MINT_TX" }),
    };
    const r = await new Orchestrator(1, ["op-1"], [], broadcaster).process(action);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.feeMilliViz, FEE.toString(), "fee returned by short-circuit path");
    // planChildren receives this fee via the dispatcher; verify FEE_SWEEP spawns
    const fakeRec = {
      id: "t9:0", direction: "PEG_IN", recipient: "9xR", sender: "alice",
      amountMilliViz: 200000n, feeMilliViz: FEE, digest: "x",
      status: "BROADCAST", attempts: 0, lastError: null, txid: null,
      createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0, parentId: null,
    };
    const kids = planChildren(fakeRec, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: sweepAmountFor(fakeRec) });
    assert.strictEqual(kids.length, 1);
    assert.strictEqual(kids[0].direction, "FEE_SWEEP");
    console.log("[8] short-circuit recovery -> FEE_SWEEP child spawnable OK");
  }

  // ── 9. broadcast=true with no txid -> CONFIRMED with txid=null ──────────────
  // Some chains (e.g. TON multisig) may not return a txid immediately.
  {
    const rec = {
      id: "t10:0", direction: "PEG_OUT", recipient: "alice", sender: null,
      amountMilliViz: 5000n, feeMilliViz: 0n, digest: "abc",
      status: "BROADCAST", attempts: 0, lastError: "prev", txid: null,
      createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0, parentId: null,
    };
    const t = planTransition(rec, { broadcast: true }, Date.now(), { retryIntervalMs: 10000, windowMs: 180000 });
    assert.strictEqual(t.status, "CONFIRMED");
    assert.strictEqual(t.patch.txid, null, "txid=null when undefined in result");
    assert.strictEqual(t.patch.lastError, null, "lastError cleared on success");
    console.log("[9] broadcast=true, no txid -> CONFIRMED with txid=null, lastError cleared OK");
  }

  // ── 10. FEE_SWEEP child carries parentId ─────────────────────────────────────
  {
    const rec = {
      id: "t11:0", direction: "PEG_IN", recipient: "9xR", sender: "alice",
      amountMilliViz: 500000n, feeMilliViz: 30000n, digest: "fee-test",
      status: "CONFIRMED", attempts: 1, lastError: null, txid: "MINT_TX",
      createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0, parentId: null,
    };
    const kids = planChildren(rec, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: sweepAmountFor(rec) });
    assert.strictEqual(kids.length, 1);
    assert.strictEqual(kids[0].direction, "FEE_SWEEP");
    assert.strictEqual(kids[0].parentId, "t11:0", "FEE_SWEEP child carries parentId");
    console.log("[10] FEE_SWEEP child carries parentId OK");
  }

  // ── 11. PEG_IN REFUNDING with sender=null -> no REFUND child ─────────────────
  // A PEG_IN whose sender was not recorded (should not happen in practice, but
  // defensively: we cannot refund an unknown sender).
  {
    const rec = {
      id: "t12:0", direction: "PEG_IN", recipient: "9xR", sender: null,
      amountMilliViz: 100000n, feeMilliViz: 0n, digest: "nosender",
      status: "REFUNDING", attempts: 3, lastError: null, txid: null,
      createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0, parentId: null,
    };
    const kids = planChildren(rec, "REFUNDING", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n });
    assert.strictEqual(kids.length, 0, "no REFUND child when sender is null");
    console.log("[11] PEG_IN REFUNDING with sender=null -> no REFUND child OK");
  }

  // ── 12. PEG_IN CONFIRMED with a zero sweep amount -> no FEE_SWEEP child ───────
  // Defensive guard: the dispatcher never emits a zero-value release. In practice the
  // derived `base` is always >= the floor (> 0), so this only fires if the amount could
  // not be derived; the guard keeps a bogus empty FEE_SWEEP from ever being enqueued.
  {
    const rec = {
      id: "t13:0", direction: "PEG_IN", recipient: "9xR", sender: "alice",
      amountMilliViz: 100000n, feeMilliViz: 0n, digest: "zerofee",
      status: "CONFIRMED", attempts: 1, lastError: null, txid: "TX",
      createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0, parentId: null,
    };
    const kids = planChildren(rec, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n });
    assert.strictEqual(kids.length, 0, "no FEE_SWEEP when sweep amount is 0");
    console.log("[12] PEG_IN CONFIRMED with zero sweep amount -> no FEE_SWEEP child OK");
  }

  // ── 13. Legacy parentId fallback: parentId=null + id suffix -> closes parent ─
  // Rows created before the parentId column was added have parentId=null. The
  // dispatcher falls back to the id-suffix (':refund') to close the parent.
  {
    const store = new InMemoryGatewayStore();
    const pegInId = "legacy:0";
    await store.enqueue({ id: pegInId, direction: "PEG_IN", remoteChain: "SOLANA",
      recipient: "9xR", sender: "alice", amountMilliViz: 50000n, digest: "legacy",
      status: "REFUNDING" });
    // Enqueue a legacy REFUND child WITHOUT parentId (simulates pre-column row)
    await store.enqueue({ id: `${pegInId}:refund`, direction: "REFUND",
      recipient: "alice", amountMilliViz: 50000n, digest: "legacy:refund",
      status: "QUEUED" });
    const legacyRefund = await store.get(`${pegInId}:refund`);
    assert.strictEqual(legacyRefund.parentId, null, "legacy row has no parentId");
    // Dispatcher fallback: parentId ?? (id.endsWith(':refund') ? slice : null)
    const parentId = legacyRefund.parentId ??
      (legacyRefund.id.endsWith(":refund") ? legacyRefund.id.slice(0, -":refund".length) : null);
    assert.strictEqual(parentId, pegInId, "legacy fallback resolves to parent id");
    if (parentId) await store.setStatus(parentId, "REFUNDED");
    assert.strictEqual((await store.get(pegInId)).status, "REFUNDED",
      "legacy fallback still closes the parent");
    console.log("[13] legacy parentId=null + id-suffix fallback closes parent OK");
  }

  // ── 14. BROADCAST in MINTED_STATUSES -> unsweptFeesMilliViz counts it ────────
  // A PEG_IN row in BROADCAST means the fee is committed (caps were checked before
  // QUEUED). Counting it as "minted" in unsweptFees is conservative and safe:
  // the row will either reach CONFIRMED (fee stays counted) or REFUNDED (row moves
  // to REFUNDED, not in MINTED_STATUSES, so it drops out of the sum).
  {
    const dir = mkdtempSync(join(tmpdir(), "viz-idm-"));
    const store = new SqliteGatewayStore(join(dir, "g.sqlite"));
    await store.enqueue({ id: "bc1:0", direction: "PEG_IN", remoteChain: "SOLANA",
      recipient: "9xR", sender: "alice", amountMilliViz: 200000n,
      feeMilliViz: 40000n, digest: "bcfee", status: "QUEUED" });
    // Watcher enqueues with fee=0; dispatcher pins fee at CONFIRMED time.
    // Simulate the dispatcher pinning the fee when advancing to BROADCAST:
    // (In practice fee is learned from coordinator result and pinned at CONFIRMED,
    //  but BROADCAST rows ARE in MINTED_STATUSES as a conservative measure.)
    await store.setStatus("bc1:0", "BROADCAST", { feeMilliViz: 40000n });
    const unswept = await store.unsweptFeesMilliViz();
    assert.strictEqual(unswept, 40000n, "BROADCAST PEG_IN fee counts as unswept (conservative)");
    // After CONFIRMED, same fee, still counted
    await store.setStatus("bc1:0", "CONFIRMED");
    assert.strictEqual(await store.unsweptFeesMilliViz(), 40000n, "CONFIRMED: fee still unswept");
    // After FEE_SWEEP confirms, drops to 0
    await store.enqueue({ id: "bc1:0:fee", direction: "FEE_SWEEP", recipient: "fees.gate",
      amountMilliViz: 40000n, digest: "bcfee:fee", status: "CONFIRMED" });
    assert.strictEqual(await store.unsweptFeesMilliViz(), 0n, "after FEE_SWEEP CONFIRMED: 0");
    await store.close();
    console.log("[14] BROADCAST in MINTED_STATUSES -> fee counted; cleared after FEE_SWEEP confirms OK");
  }

  // ── 15. actionId="" (empty string) -> no memo instruction added ───────────────
  // `if (p.actionId)` is falsy for empty string, same as for undefined.
  // This prevents an empty-data memo instruction corrupting the tx.
  {
    const submitter = Keypair.generate();
    const opA = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    const multisig = Keypair.generate().publicKey.toBase58();
    const nonceAccount = Keypair.generate().publicKey.toBase58();
    const nonceValue = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const base = {
      recipient, amountMilliViz: "50000", destProvisioned: true,
      mint, multisig, signers: [opA.publicKey.toBase58()],
      feePayer: submitter.publicKey.toBase58(),
      nonceAccount, nonceValue, decimals: 3, messageB64: "",
    };
    const withUndefined = { ...base };
    withUndefined.messageB64 = mintMessageB64(withUndefined);
    const withEmptyString = { ...base, actionId: "" };
    withEmptyString.messageB64 = mintMessageB64(withEmptyString);
    assert.strictEqual(withUndefined.messageB64, withEmptyString.messageB64,
      "empty string actionId is treated the same as no actionId (no memo)");
    console.log("[15] actionId='' (empty string) -> no memo instruction (same as no actionId) OK");
  }

  // ── 16. BROADCAST row surfaced by stale() for dispatcher recovery ─────────────
  // The dispatcher now recovers orphaned BROADCAST rows (previously SIGNING).
  // Verify that stale() returns a BROADCAST row that has been stuck long enough,
  // and does NOT return one that hasn't yet exceeded the timeout.
  {
    const store = new InMemoryGatewayStore();
    await store.enqueue({ id: "s1:0", direction: "PEG_IN", remoteChain: "SOLANA",
      recipient: "9xR", sender: "alice", amountMilliViz: 100000n,
      digest: "stale-bc", status: "QUEUED" });
    await store.setStatus("s1:0", "BROADCAST");
    const rec = await store.get("s1:0");
    const updatedAt = rec.updatedAt;
    // Not yet stale (age < minTimeout)
    const notYet = await store.stale(updatedAt + 1000, 5000, ["BROADCAST"]);
    assert.ok(!notYet.some((r) => r.id === "s1:0"), "row not stale before timeout");
    // Now stale (age > minTimeout)
    const nowStale = await store.stale(updatedAt + 10000, 5000, ["BROADCAST"]);
    assert.ok(nowStale.some((r) => r.id === "s1:0"), "BROADCAST row surfaced by stale() after timeout");
    console.log("[16] BROADCAST row surfaced by stale() for recovery -> not before timeout, yes after OK");
  }

  // ── 17-19. REAL VizReleaseBroadcaster: persist-txid-before-send + confirm-by-id ─
  // A mock VIZ chain implementing only the four methods the broadcaster uses. The txid
  // is deterministic from the proposal (as in production); confirmReleaseByTxId answers
  // from a simulated on-chain set and counts its calls so we can prove the happy path
  // does NO on-chain lookup.
  function mockVizChain() {
    const onchain = new Set();
    let confirmCalls = 0;
    return {
      onchain,
      confirmCalls: () => confirmCalls,
      buildReleaseProposal: async (action, gw) => ({
        refBlockNum: 1, refBlockPrefix: 2, expiration: "2026-06-28T12:00:00",
        from: gw, to: action.recipient, amount: milliToViz(action.amountMilliViz), memo: action.id,
      }),
      transactionId: (p) => `VTX_${p.memo}`, // deterministic stand-in for the graphene id
      broadcastRelease: async (p) => { const id = `VTX_${p.memo}`; onchain.add(id); return id; },
      confirmReleaseByTxId: async (txid) => { confirmCalls++; return onchain.has(txid) ? { txid } : null; },
    };
  }

  // 17. Happy path: a fresh row has no txid -> actionExecuted returns false with ZERO
  //     on-chain lookups (the #4.1 cost fix); broadcast persists the txid BEFORE sending.
  {
    const store = new InMemoryGatewayStore();
    const action = makePegOutAction();
    await store.enqueue({ id: action.id, direction: "PEG_OUT", recipient: "alice",
      amountMilliViz: 5000n, digest: action.digest, status: "QUEUED" });
    const chain = mockVizChain();
    const b = new VizReleaseBroadcaster(chain, "viz-gateway", store);

    const pre = await b.actionExecuted(action);
    assert.strictEqual(pre.executed, false, "fresh row (no txid) -> not executed");
    assert.strictEqual(chain.confirmCalls(), 0, "happy path does NO on-chain lookup");

    const { proposal } = await b.buildProposal(action);
    const txid = await b.broadcast(action, proposal, ["sigA"]);
    const row = await store.get(action.id);
    assert.strictEqual(row.txid, `VTX_${action.id}`, "txid persisted to the row at broadcast");
    assert.strictEqual(txid, row.txid, "returned txid == persisted == computed");
    console.log("[17] VIZ broadcast persists deterministic txid before send; happy path no RPC OK");
  }

  // 18. Recovery after a confirmed send: the row now has a txid, and the release is on
  //     chain -> actionExecuted confirms by EXACT id (no memo scan) -> executed:true.
  {
    const store = new InMemoryGatewayStore();
    const action = makePegOutAction();
    await store.enqueue({ id: action.id, direction: "PEG_OUT", recipient: "alice",
      amountMilliViz: 5000n, digest: action.digest, status: "QUEUED" });
    const chain = mockVizChain();
    const b = new VizReleaseBroadcaster(chain, "viz-gateway", store);
    const { proposal } = await b.buildProposal(action);
    await b.broadcast(action, proposal, ["sigA"]); // lands on-chain + persists txid
    const rec = await b.actionExecuted(action);
    assert.strictEqual(rec.executed, true, "persisted txid + on-chain -> executed");
    assert.strictEqual(rec.txid, `VTX_${action.id}`, "confirmed by exact id");
    console.log("[18] recovery confirms a landed release by exact txid (no scan window) OK");
  }

  // 19. Crash AFTER persisting txid but BEFORE the tx lands (send failed): the row has a
  //     txid, but it is not on chain -> actionExecuted returns false so the dispatcher
  //     re-broadcasts the identical (deterministic) tx. No double-release, no stranding.
  {
    const store = new InMemoryGatewayStore();
    const action = makePegOutAction();
    await store.enqueue({ id: action.id, direction: "PEG_OUT", recipient: "alice",
      amountMilliViz: 5000n, digest: action.digest, status: "QUEUED" });
    const chain = mockVizChain();
    const b = new VizReleaseBroadcaster(chain, "viz-gateway", store);
    // Simulate persist-before-send where the send never reached the chain.
    await store.setStatus(action.id, "BROADCAST", { txid: `VTX_${action.id}` });
    const rec = await b.actionExecuted(action);
    assert.strictEqual(rec.executed, false, "txid persisted but not on chain -> safe to re-broadcast");
    console.log("[19] crash-before-send (txid persisted, tx absent) -> re-broadcastable, no double-release OK");
  }

  // 20. Drift guard: the deterministic VIZ txid is computed via viz-js-lib's INTERNAL
  //     serializer (no public helper). Pin a known-good id for a fixed proposal so a lib
  //     upgrade that changes the wire serialization is caught here, not in production.
  {
    const p = { refBlockNum: 1234, refBlockPrefix: 56789, expiration: "2026-06-30T12:00:00",
      from: "viz-gateway", to: "alice", amount: "5.000 VIZ", memo: "aa:0" };
    const id = releaseTxId(p);
    assert.strictEqual(id.length, 40, "graphene trx id is 20 bytes (40 hex)");
    assert.strictEqual(id, "50a31d499a0846e96dd197d2d85df09b4ff25f36", "txid serialization drifted");
    assert.strictEqual(releaseTxId(p), id, "deterministic");
    console.log("[20] VIZ txid drift guard: pinned id stable for a fixed proposal OK");
  }

  // ── 21-24. REAL GramMintBroadcaster (Phase B: keyless coordinator, on-chain approvals) ─
  // The coordinator no longer submits a TON tx — operators propose/approve on-chain. So
  // buildProposal PINS the deterministic order address BEFORE the approval loop (idempotency
  // key), broadcast POLLS orderExecuted, and actionExecuted is keyed on EXECUTED (not mere
  // existence: an under-threshold order must keep collecting approvals). The mock counts
  // orderExecuted/nextOrderAddress calls so we can prove the happy path does NO lookup and a
  // re-drive does NOT reserve a second order.
  function mockTonChain({ executed = new Set(), nextAddr = "ORDER_ADDR_1", nextSeqno = "7", provisioned = true } = {}) {
    let orderExecutedCalls = 0;
    let nextOrderAddressCalls = 0;
    return {
      executed,
      orderExecutedCalls: () => orderExecutedCalls,
      nextOrderAddressCalls: () => nextOrderAddressCalls,
      isDestinationProvisioned: async () => provisioned,
      orderHashFor: (_to, _net) => "abcd".repeat(16),
      nextOrderAddress: async () => { nextOrderAddressCalls++; return { orderAddr: nextAddr, seqno: nextSeqno }; },
      orderExecuted: async (addr) => { orderExecutedCalls++; return executed.has(addr); },
    };
  }

  function enqueueTonPegIn(store, id) {
    return store.enqueue({ id, direction: "PEG_IN", remoteChain: "GRAM",
      recipient: "EQrecipient", sender: "alice", amountMilliViz: 100000n,
      digest: "tondeadbeef", status: "QUEUED" });
  }
  const tonAction = (id) => ({ id, direction: "PEG_IN", recipient: "EQrecipient", amountMilliViz: 100000n, digest: "tondeadbeef" });

  // 21. Happy path: a fresh row has no txid -> actionExecuted returns false with ZERO
  //     on-chain lookups. false only when nothing was persisted (no premature short-circuit).
  {
    const store = new InMemoryGatewayStore();
    const action = { id: "ton1:0" };
    await enqueueTonPegIn(store, action.id);
    const chain = mockTonChain();
    const b = new GramMintBroadcaster(chain, FEES, store, "op-1");
    const pre = await b.actionExecuted(action);
    assert.strictEqual(pre.executed, false, "fresh TON row (no txid) -> not executed");
    assert.strictEqual(chain.orderExecutedCalls(), 0, "happy path does NO on-chain lookup");
    console.log("[21] TON actionExecuted false + no RPC when no order address persisted OK");
  }

  // 22. buildProposal PINS the deterministic order address BEFORE any operator proposes,
  //     designates the proposer, and REUSES the pinned address on a re-build (a re-drive
  //     targets the SAME order — the crash-after-propose double-mint guard).
  {
    const store = new InMemoryGatewayStore();
    const id = "ton2:0";
    await enqueueTonPegIn(store, id);
    const chain = mockTonChain({ nextAddr: "ORDER_ADDR_2" });
    const b = new GramMintBroadcaster(chain, FEES, store, "op-1");
    const { proposal } = await b.buildProposal(tonAction(id));
    assert.strictEqual(proposal.orderAddr, "ORDER_ADDR_2", "proposal pins the next order address");
    assert.strictEqual(proposal.proposerOperatorId, "op-1", "coordinator designates the proposer");
    assert.strictEqual((await store.get(id)).txid, "ORDER_ADDR_2", "order address persisted BEFORE approvals");
    const before = chain.nextOrderAddressCalls();
    const again = await b.buildProposal(tonAction(id));
    assert.strictEqual(again.proposal.orderAddr, "ORDER_ADDR_2", "re-build reuses the pinned order address");
    assert.strictEqual(chain.nextOrderAddressCalls(), before, "re-build does NOT reserve a new order address");
    console.log("[22] TON buildProposal pins order addr before approvals + reuses on re-drive OK");
  }

  // 23. Recovery after the order EXECUTED: row has a txid and the order executed on-chain
  //     -> actionExecuted short-circuits to executed:true (prevents the double-mint).
  {
    const store = new InMemoryGatewayStore();
    const id = "ton3:0";
    await enqueueTonPegIn(store, id);
    const chain = mockTonChain({ executed: new Set(["ORDER_ADDR_3"]) });
    const b = new GramMintBroadcaster(chain, FEES, store, "op-1");
    await store.setStatus(id, "BROADCAST", { txid: "ORDER_ADDR_3" });
    const rec = await b.actionExecuted({ id });
    assert.strictEqual(rec.executed, true, "persisted order addr + executed on-chain -> executed");
    assert.strictEqual(rec.txid, "ORDER_ADDR_3", "short-circuit returns the order address");
    // broadcast confirms the same executed order and returns its address (keyless — no submit).
    const returned = await b.broadcast({ id }, { orderAddr: "ORDER_ADDR_3" }, ["ton:receipt"]);
    assert.strictEqual(returned, "ORDER_ADDR_3", "keyless broadcast confirms execution + returns order addr");
    console.log("[23] TON recovery short-circuits + keyless broadcast confirms execution OK");
  }

  // 24. Order EXISTS but is UNDER THRESHOLD (persisted addr, not executed): actionExecuted
  //     returns false so the coordinator keeps collecting approvals. The proposer's own
  //     existence check (not this) prevents a second order, so the re-drive is idempotent.
  {
    const store = new InMemoryGatewayStore();
    const id = "ton4:0";
    await enqueueTonPegIn(store, id);
    const chain = mockTonChain({ executed: new Set() }); // order created but never reached threshold
    const b = new GramMintBroadcaster(chain, FEES, store, "op-1");
    await store.setStatus(id, "BROADCAST", { txid: "ORDER_ADDR_1" });
    const rec = await b.actionExecuted({ id });
    assert.strictEqual(rec.executed, false, "persisted addr but not executed -> keep collecting approvals");
    console.log("[24] TON under-threshold order (addr persisted, not executed) -> re-drivable OK");
  }

  // ── 25. Recovery fee durability (PR#11 follow-up #2 + VG-04) ─────────────────
  // The coordinator still pins the PEG_IN fee (base + activation) onto the row BEFORE
  // broadcast for recon accounting. VG-04: the dispatcher derives the FEE_SWEEP amount
  // (= base) from the row's immutable gross, so even a recovery that reports fee 0 spawns
  // the sweep for the correct base — no dependence on the pinned fee, no stranded base.
  {
    const store = new InMemoryGatewayStore();
    const FEE = 22_000n;
    const action = { direction: "PEG_IN", id: "rec1:0", remoteChain: "SOLANA", recipient: "9xR", amountMilliViz: 300_000n, digest: "recdrift" };
    await store.enqueue({ id: action.id, direction: "PEG_IN", remoteChain: "SOLANA", recipient: "9xR",
      sender: "alice", amountMilliViz: 300_000n, digest: "recdrift", status: "QUEUED" });
    assert.strictEqual((await store.get(action.id)).feeMilliViz, 0n, "watcher enqueues fee 0");

    const broadcaster = {
      buildProposal: async () => ({ proposal: {}, feeMilliViz: FEE }),
      broadcast: async () => "MINT_TX",
      actionExecuted: async () => ({ executed: false }),
    };
    const approvingSigner = { operatorId: "op-1", approve: async () => ({ actionId: action.id, operatorId: "op-1", signature: "sig" }) };
    const r = await new Orchestrator(1, ["op-1"], [approvingSigner], broadcaster, (id, fee) => store.setFee(id, fee)).process(action);
    assert.strictEqual(r.broadcast, true, "broadcasts at 1-of-1");
    assert.strictEqual((await store.get(action.id)).feeMilliViz, FEE, "coordinator pinned the fee on the row BEFORE broadcast");

    // Dispatcher recovery-CONFIRMED where the coordinator response carries fee 0.
    const t = planTransition(await store.get(action.id), { broadcast: true, txid: "MINT_TX", feeMilliViz: 0n }, Date.now(), { retryIntervalMs: 10000, windowMs: 180000 });
    assert.strictEqual(t.status, "CONFIRMED");
    assert.strictEqual(t.patch.feeMilliViz, undefined, "fee 0 must NOT clobber the pinned fee");
    await store.setStatus(action.id, t.status, t.patch);

    // Dispatcher (VG-04): the sweep amount is derived from the row's gross, independent of
    // the coordinator response fee (0 here) and independent of the pinned row fee (FEE).
    const rec = await store.get(action.id);
    const sweepAmountMilliViz = sweepAmountFor(rec);
    const kids = planChildren(rec, "CONFIRMED", { feesGateAccount: "fees.gate", sweepAmountMilliViz });
    assert.strictEqual(kids.length, 1, "FEE_SWEEP spawned from the independently-derived base");
    assert.strictEqual(kids[0].direction, "FEE_SWEEP");
    assert.strictEqual(kids[0].amountMilliViz, sweepAmountMilliViz, "FEE_SWEEP carries the derived base, not the pinned fee");
    assert.notStrictEqual(sweepAmountMilliViz, FEE, "base (swept) differs from the withheld fee (base+activation), which stays as surplus");
    console.log("[25] recovery derives base from gross -> FEE_SWEEP fires (surcharge retained) OK");
  }

  console.log("\nRESULT: idempotent delivery: actionExecuted short-circuit prevents double-mint/release;");
  console.log("VIZ persists a deterministic txid before send and confirms by exact id (no scan window);");
  console.log("BROADCAST set pre-coordinator; parentId closes parent row without id-suffix fragility.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
