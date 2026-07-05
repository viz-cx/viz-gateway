// SPIKE: signer source validation for gateway-INTERNAL VIZ releases (FEE_SWEEP / REFUND).
//
// These have no remote source event to re-read; the signer instead re-derives them from
// the PEG_IN they settle (re-read from the operator's OWN VIZ node). Proves:
//   - FEE_SWEEP may only ever release to the operator's OWN fees.gate, for EXACTLY the
//     independently-derived `base` fee (VG-04: no range — base + activation, the old band
//     maximum, is now REJECTED, closing the backing-drain vector; the surcharge is retained
//     as gateway surplus);
//   - REFUND may only ever return the GROSS deposit to the deposit's ORIGINAL sender;
//   - every child digest is bound to the re-derived parent PEG_IN digest;
//   - a missing/non-final parent, a malformed child id, or any tampered field FAILS CLOSED.
//
// Run (after `npm run build`): node tools/fee-sweep-refund-spike.cjs
const { canonicalPegIn, baseFee, pegInFeePolicyFor } = require("@gateway/common");
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
  // Identical fee config every operator runs (see GatewayFeeConfig).
  const fees = {
    floorMilliViz: 10_000n,
    bps: 20,
    activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 10_000n },
    mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
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

  // The independently-derived EXACT sweep amount for this deposit (VG-04): always `base`.
  const policy = pegInFeePolicyFor(fees, deposit.remoteChain);
  const base = baseFee(deposit.amountMilliViz, policy); // the only amount the signer will sign
  const withheldMax = base + policy.activationSurchargeMilliViz; // base + activation — the OLD band max, now rejected

  const deps = (dep) => ({
    vizChain: { getDeposit: async () => dep },
    solanaChain: { getBurn: async () => null },
    tonChain: { getBurn: async () => null },
    store: { depositAddressBy: async () => undefined },
    fees,
    feesGateAccount: FEES_GATE,
  });

  // Build the FEE_SWEEP / REFUND child actions exactly as dispatcher/policy.ts planChildren does.
  const feeSweep = (over = {}) => ({
    direction: "PEG_OUT",
    id: `${parentId}:fee`,
    recipient: FEES_GATE,
    amountMilliViz: base,
    digest: `${parent.digest}:fee`,
    ...over,
  });
  const refund = (over = {}) => ({
    direction: "PEG_OUT",
    id: `${parentId}:refund`,
    recipient: deposit.from, // back to the original sender
    amountMilliViz: deposit.amountMilliViz, // gross, no fee
    digest: `${parent.digest}:refund`,
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

  // 8) Honest REFUND: gross back to the original sender -> passes.
  {
    await validateAction(refund(), deps(deposit));
    ok("8 honest REFUND (gross -> original sender) -> signs");
  }

  // 9) Redirected REFUND: coordinator sends the refund to someone other than the sender -> rejected.
  {
    await expectReject(validateAction(refund({ recipient: "attacker" }), deps(deposit)), "9 REFUND wrong recipient");
  }

  // 10) Tampered REFUND amount: not the gross deposit -> rejected (no tolerance on a refund).
  {
    await expectReject(validateAction(refund({ amountMilliViz: deposit.amountMilliViz + 1n }), deps(deposit)), "10 REFUND wrong amount");
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

  if (failures > 0) {
    console.error(`\nRESULT: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nRESULT: FEE_SWEEP sweeps only to the operator's own fees.gate for EXACTLY the derived base fee");
  console.log("(VG-04: base+activation drain rejected); REFUND returns only the gross deposit to the original");
  console.log("sender; both bind to the parent PEG_IN.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
