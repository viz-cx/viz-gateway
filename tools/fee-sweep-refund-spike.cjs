// SPIKE: signer source validation for gateway-INTERNAL VIZ releases (FEE_SWEEP / REFUND).
//
// These have no remote source event to re-read; the signer instead re-derives them from
// the PEG_IN they settle (re-read from the operator's OWN VIZ node). Proves:
//   - FEE_SWEEP may only ever release to the operator's OWN fees.gate, for EXACTLY the
//     independently-derived `base` fee (VG-04: no range — base + activation, the old band
//     maximum, is now REJECTED, closing the backing-drain vector; the surcharge is retained
//     as gateway surplus);
//   - REFUND may only ever return gross − refund fee (anti-spam, PR #87) to the deposit's ORIGINAL sender;
//   - every child digest is bound to the re-derived parent PEG_IN digest;
//   - a missing/non-final parent, a malformed child id, or any tampered field FAILS CLOSED.
//
// Run (after `npm run build`): node tools/fee-sweep-refund-spike.cjs
const { canonicalPegIn, baseFee, pegInFeePolicyFor, GatewayAccounts } = require("@gateway/common");
const { validateAction, SourceMismatchError } = require("../packages/signer/dist/sourceValidator.js");

let failures = 0;
const ok = (msg) => console.log(`[PASS] ${msg}`);
const bad = (msg) => {
  console.error(`[FAIL] ${msg}`);
  failures++;
};

async function expectReject(promise, label) {
  try {
    await promise;
    bad(`${label}: expected rejection but it resolved`);
  } catch (e) {
    if (e instanceof SourceMismatchError) ok(`${label}: rejected (${e.message.split(":")[0]})`);
    else bad(`${label}: threw the wrong error type: ${e}`);
  }
}

(async () => {
  // --- shared fixtures ----------------------------------------------------------
  const FEES_GATE = "fees.gate";
  // Identical fee config every operator runs — the FULL GatewayFeeConfig shape.
  const fees = {
    floorMilliViz: 10_000n,
    gramFloorMilliViz: 45_000n,
    bps: 20,
    activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 10_000n },
    mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
    mintGasTon: 0.06,
    walletDeployGasTon: 0.05,
    margin: 1.5,
    gramVizPerTon: 500,
    refundFeeMilliViz: 5_000n,
  };

  // The TRUE parent PEG_IN deposit the operator's own VIZ node would return.
  const deposit = {
    trxId: "6b243510d40c3c593fcda9a01288aaa37b0a8422",
    opIndex: 0,
    blockNum: 81_000_000,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1_068_237n,
    remoteChain: "GRAM",
    remoteDestination: "EQsomeTonAddress",
  };
  const parent = canonicalPegIn(deposit);
  const parentId = parent.id; // "<trxId>:<opIndex>"

  // The independently-derived EXACT sweep amount for this deposit (VG-04): always `base`, computed
  // with pegInFeePolicyFor — the SAME policy validateFeeSweep uses (GRAM static floor = 45000 mVIZ),
  // so the spike's expected base matches the signer's byte-for-byte.
  const policy = pegInFeePolicyFor(fees, deposit.remoteChain);
  const base = baseFee(deposit.amountMilliViz, policy); // the only amount the signer will sign
  const withheldMax = base + policy.activationSurchargeMilliViz; // base + activation — the OLD band max, now rejected

  // accounts: deposit lands at "viz-gateway" (GRAM backing account for this spike fixture)
  const spikeAccounts = new GatewayAccounts({ GRAM: "viz-gateway", SOLANA: "solana.gate" });
  const deps = (dep) => ({
    vizChain: { getDeposit: async () => dep },
    solanaChain: { getBurn: async () => null },
    tonChain: { getBurn: async () => null },
    store: { depositAddressBy: async () => undefined },
    fees,
    feesGateAccount: FEES_GATE,
    accounts: spikeAccounts,
  });

  // Build the FEE_SWEEP / REFUND child actions exactly as dispatcher/policy.ts planChildren does.
  const feeSweep = (over = {}) => ({
    direction: "PEG_OUT",
    id: `${parentId}:fee`,
    recipient: FEES_GATE,
    amountMilliViz: base,
    digest: `${parent.digest}:fee`,
    remoteChain: deposit.remoteChain, // inherited from parent (Task 3.2/3.4)
    ...over,
  });
  const refundNet = deposit.amountMilliViz - fees.refundFeeMilliViz; // gross − refund fee (anti-spam, PR #87)
  const refund = (over = {}) => ({
    direction: "PEG_OUT",
    id: `${parentId}:refund`,
    recipient: deposit.from, // back to the original sender
    amountMilliViz: refundNet, // gross − refund fee (exactly what dispatcher/policy.ts spawns)
    digest: `${parent.digest}:refund`,
    remoteChain: deposit.remoteChain, // inherited from parent (Task 3.2/3.4)
    ...over,
  });

  // ============================ FEE_SWEEP ========================================

  // 1) Honest FEE_SWEEP for exactly `base` -> passes (the only accepted amount).
  {
    await validateAction(feeSweep({ amountMilliViz: base }), deps(deposit));
    ok("1 honest FEE_SWEEP (fee = base) -> signs");
  }

  // 2) VG-04 core: sweeping base + activation (the OLD band maximum) is now REJECTED. This is
  //    the drain vector — a coordinator pinning destProvisioned=true at mint (net = gross-base)
  //    then sweeping base+activation would make net+fee = gross+surcharge, draining backing.
  {
    await expectReject(validateAction(feeSweep({ amountMilliViz: withheldMax }), deps(deposit)), "2 FEE_SWEEP base+activation (drain) rejected");
  }

  // 3) Redirected FEE_SWEEP: coordinator points the sweep at an attacker, not fees.gate -> rejected.
  {
    await expectReject(validateAction(feeSweep({ recipient: "attacker" }), deps(deposit)), "3 FEE_SWEEP wrong recipient");
  }

  // 4) Over-sweep by a single milli-VIZ above base -> rejected (exact, no upward tolerance).
  {
    await expectReject(validateAction(feeSweep({ amountMilliViz: base + 1n }), deps(deposit)), "4 FEE_SWEEP amount too high");
  }

  // 5) Under-sweep: amount below base -> rejected (exact, no downward tolerance).
  {
    await expectReject(validateAction(feeSweep({ amountMilliViz: base - 1n }), deps(deposit)), "5 FEE_SWEEP amount too low");
  }

  // 6) Tampered digest: not bound to the re-derived parent PEG_IN -> rejected.
  {
    await expectReject(validateAction(feeSweep({ digest: "deadbeef:fee" }), deps(deposit)), "6 FEE_SWEEP unbound digest");
  }

  // 7) Parent PEG_IN not found / not irreversible (getDeposit -> null): fail-closed reject.
  {
    await expectReject(validateAction(feeSweep(), deps(null)), "7 FEE_SWEEP parent not irreversible");
  }

  // ============================== REFUND =========================================

  // 8) Honest REFUND: gross − refund fee back to the original sender -> passes.
  {
    await validateAction(refund(), deps(deposit));
    ok("8 honest REFUND (gross − refund fee -> original sender) -> signs");
  }

  // 9) Redirected REFUND: coordinator sends the refund to someone other than the sender -> rejected.
  {
    await expectReject(validateAction(refund({ recipient: "attacker" }), deps(deposit)), "9 REFUND wrong recipient");
  }

  // 10) REFUND at the FULL gross (fee not deducted) -> rejected. This is the exact PR #87 regression:
  //     the dispatcher spawns gross − refundFee, so a full-gross refund over-pays the sender by the fee.
  {
    await expectReject(validateAction(refund({ amountMilliViz: deposit.amountMilliViz }), deps(deposit)), "10 REFUND full gross (fee not deducted)");
    await expectReject(validateAction(refund({ amountMilliViz: refundNet + 1n }), deps(deposit)), "10b REFUND 1 mVIZ over net");
  }

  // 11) Tampered REFUND digest: not bound to the parent -> rejected.
  {
    await expectReject(validateAction(refund({ digest: "deadbeef:refund" }), deps(deposit)), "11 REFUND unbound digest");
  }

  // 12) Parent PEG_IN not found (getDeposit -> null): fail-closed reject.
  {
    await expectReject(validateAction(refund(), deps(null)), "12 REFUND parent not irreversible");
  }

  // 13) Malformed child id (no "<trxId>:<opIndex>" parent structure) -> rejected.
  {
    await expectReject(validateAction(feeSweep({ id: "garbage:fee" }), deps(deposit)), "13 FEE_SWEEP malformed parent id");
  }

  // 14) Zero-padded opIndex in the child id: "<trx>:00:fee" / "<trx>:000:fee" all parseInt to the
  //     SAME parent deposit and keep the correct parent digest, so the digest bind passes — but each
  //     is a DISTINCT id, hence a distinct memo -> distinct VIZ txid, i.e. a REAL second FEE_SWEEP a
  //     compromised coordinator could harvest signatures for (unbounded, draining backing). The
  //     canonical child-id equality check must reject every non-canonical padding.
  {
    await expectReject(validateAction(feeSweep({ id: `${deposit.trxId}:00:fee` }), deps(deposit)), "14 FEE_SWEEP zero-padded child id (double-sweep)");
    await expectReject(validateAction(feeSweep({ id: `${deposit.trxId}:000:fee` }), deps(deposit)), "14 FEE_SWEEP triple-padded child id");
  }

  // 15) Same padding attack on REFUND (returns gross − fee to the sender — a double refund is worse).
  {
    await expectReject(validateAction(refund({ id: `${deposit.trxId}:00:refund` }), deps(deposit)), "15 REFUND zero-padded child id (double-refund)");
  }

  if (failures > 0) {
    console.error(`\nRESULT: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nRESULT: FEE_SWEEP sweeps only to the operator's own fees.gate for EXACTLY the derived base fee");
  console.log("(VG-04: base+activation drain rejected); REFUND returns exactly gross − refund fee to the original");
  console.log("sender; both bind to the parent PEG_IN.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
