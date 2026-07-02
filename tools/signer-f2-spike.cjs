// SPIKE: F2 — the signer's INDEPENDENT source-event validation (offline, mocked RPC).
//
// Proves the core security fix: a compromised coordinator that hands an honest signer a
// mutually-consistent (action, proposal) pair for a tampered/non-existent source event is
// REJECTED, because the signer re-derives the action from its OWN chain view and asserts
// byte-identical equality. Also proves the PDA-based deposit binding: the deposit address
// is re-derivable from the PUBLIC program ID alone, with no private key anywhere.
//
// Run (after `npm run build`): node tools/signer-f2-spike.cjs
const { canonicalPegIn, canonicalPegOut } = require("@gateway/common");
const { validateAction, SourceMismatchError } = require("../packages/signer/dist/sourceValidator.js");
const {
  depositAddress,
} = require("../packages/solana-watcher/dist/depositAddress.js");

let failures = 0;
const ok = (msg) => console.log(`[PASS] ${msg}`);
const bad = (msg) => {
  console.error(`[FAIL] ${msg}`);
  failures++;
};

// Assert that validateAction rejects with a SourceMismatchError.
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
  const FAKE_PROGRAM_ID = "GateWayDep1111111111111111111111111111111111"; // deterministic fake
  const VIZ_ACCT = "alice";
  const ALICE_DEPOSIT = depositAddress(FAKE_PROGRAM_ID, VIZ_ACCT);
  const SOL_RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; // a base58 owner
  // A Solana-signature-shaped id (86-90 base58 chars) so PEG_OUT dispatch picks Solana.
  const SOL_SIG = "5".repeat(88);

  // The TRUE peg-in deposit the operator's own VIZ node would return.
  const trueDeposit = {
    trxId: "6b243510d40c3c593fcda9a01288aaa37b0a8422",
    opIndex: 0,
    blockNum: 81_000_000,
    from: "viz-user",
    to: "viz-gateway",
    amountMilliViz: 1_068_237n,
    remoteChain: "SOLANA",
    remoteDestination: SOL_RECIPIENT,
  };

  // Mock chain readers / store. Each test swaps in the relevant behavior.
  const vizChainReturning = (deposit) => ({ getDeposit: async () => deposit });
  const solanaReturning = (burn) => ({ getBurn: async () => burn });
  const storeWith = (rec) => ({ depositAddressBy: async () => rec });

  const FEES = {
    floorMilliViz: 10_000n,
    bps: 20,
    activationSurchargeMilliViz: { SOLANA: 10_000n, TON: 10_000n },
    mintGasFloorMilliViz: { SOLANA: 1_000n, TON: 1_000n },
  };
  const FEES_GATE = "fees.gate";

  const depsPegIn = (deposit) => ({
    vizChain: vizChainReturning(deposit),
    solanaChain: solanaReturning(null),
    tonChain: solanaReturning(null),
    store: storeWith(undefined),
    depositProgramId: FAKE_PROGRAM_ID,
    fees: FEES,
    feesGateAccount: FEES_GATE,
  });

  // ============================ PEG_IN cases ====================================

  // 1) Honest PEG_IN: source matches the wire action exactly -> passes.
  {
    const action = canonicalPegIn(trueDeposit);
    await validateAction(action, depsPegIn(trueDeposit));
    ok("1 honest PEG_IN: source-derived action matches -> signs");
  }

  // 2) Tampered PEG_IN recipient: coordinator crafts a self-consistent action for a
  //    DIFFERENT recipient; the real source has the true recipient -> rejected.
  {
    const tampered = canonicalPegIn({ ...trueDeposit, remoteDestination: "EVILdestination1111111111111111111111" });
    await expectReject(validateAction(tampered, depsPegIn(trueDeposit)), "2 tampered PEG_IN recipient");
  }

  // 3) Tampered PEG_IN amount: coordinator inflates the mint amount -> rejected.
  {
    const tampered = canonicalPegIn({ ...trueDeposit, amountMilliViz: 999_999_999n });
    await expectReject(validateAction(tampered, depsPegIn(trueDeposit)), "3 tampered PEG_IN amount");
  }

  // 3b) Source not found / not irreversible (getDeposit -> null): fail-closed reject.
  {
    const action = canonicalPegIn(trueDeposit);
    await expectReject(validateAction(action, depsPegIn(null)), "3b PEG_IN source not irreversible");
  }

  // 3c) Mutated id, same source event: a compromised coordinator keeps the honest
  //     digest (which binds "<trxId>:<opIndex>") but appends a trailing char to the id
  //     ("...:0x"). A lenient opIndex parse used to resolve this to the REAL deposit and
  //     pass every field check, forging a distinct outbox key / Solana memo -> a SECOND
  //     mint for one deposit. Must now fail closed (strict parse + id equality).
  {
    const honest = canonicalPegIn(trueDeposit);
    const forged = { ...honest, id: `${honest.id}x` }; // digest still binds the real id
    await expectReject(validateAction(forged, depsPegIn(trueDeposit)), "3c mutated PEG_IN id (double-mint replay)");
  }

  // =========================== PEG_OUT (Solana) =================================

  // The TRUE burn the operator's own Solana node would return (homeDestination filled
  // by the validator after the binding check, so the adapter leaves it "").
  const trueBurn = {
    sourceId: SOL_SIG,
    height: 1234,
    from: ALICE_DEPOSIT, // burn authority = alice's PDA deposit address
    amountMilliViz: 500_000n,
    homeDestination: "",
  };
  const depsPegOut = (burn, rec) => ({
    vizChain: vizChainReturning(null),
    solanaChain: solanaReturning(burn),
    tonChain: solanaReturning(null),
    store: storeWith(rec),
    depositProgramId: FAKE_PROGRAM_ID,
    fees: FEES,
    feesGateAccount: FEES_GATE,
  });
  const aliceRec = { vizAccount: VIZ_ACCT, solAddress: ALICE_DEPOSIT, wvizAta: "ata", createdAt: 0, scanTime: 0, priority: 0 };

  // 4) Honest PEG_OUT Solana: burn source binds to alice; release target = alice -> passes.
  {
    const action = canonicalPegOut({ ...trueBurn, homeDestination: VIZ_ACCT });
    await validateAction(action, depsPegOut({ ...trueBurn }, aliceRec));
    ok("4 honest PEG_OUT Solana: burn binds to alice -> signs");
  }

  // 5) Tampered PEG_OUT recipient: coordinator redirects alice's burn to "bob" -> rejected.
  {
    const tampered = canonicalPegOut({ ...trueBurn, homeDestination: "bob" });
    await expectReject(validateAction(tampered, depsPegOut({ ...trueBurn }, aliceRec)), "5 tampered PEG_OUT recipient");
  }

  // 5b) Tampered registry binding: a registry row claims alice's deposit address belongs
  //     to "bob"; the PDA re-derivation depositAddress(programId, "bob") != alice's address
  //     -> rejected (proves a poisoned registry cannot redirect funds).
  {
    const action = canonicalPegOut({ ...trueBurn, homeDestination: "bob" });
    const poisoned = { ...aliceRec, vizAccount: "bob" };
    await expectReject(validateAction(action, depsPegOut({ ...trueBurn }, poisoned)), "5b poisoned registry binding");
  }

  // 6) Unknown deposit address: no registry row for the burn source -> rejected.
  {
    const action = canonicalPegOut({ ...trueBurn, homeDestination: VIZ_ACCT });
    await expectReject(validateAction(action, depsPegOut({ ...trueBurn }, undefined)), "6 unknown deposit address");
  }

  // 6b) Burn not found / not finalized (getBurn -> null): fail-closed reject.
  {
    const action = canonicalPegOut({ ...trueBurn, homeDestination: VIZ_ACCT });
    await expectReject(validateAction(action, depsPegOut(null, aliceRec)), "6b PEG_OUT burn not finalized");
  }

  // 6c) TON-shaped PEG_OUT id (64-hex burn tx hash) but the operator's TON node has no such
  //     burn (getBurn -> null): the TON branch fails closed. Full TON validation is exercised
  //     in tools/ton-pegout-f2-spike.cjs; here we just prove the dispatch + fail-closed path.
  {
    const tonHash = "a".repeat(64); // 64-hex burn tx hash — routes to the TON branch
    const action = canonicalPegOut({ ...trueBurn, sourceId: tonHash, homeDestination: VIZ_ACCT });
    await expectReject(validateAction(action, depsPegOut({ ...trueBurn, sourceId: tonHash }, aliceRec)), "6c TON PEG_OUT burn not final (fail-closed)");
  }

  // 6d) An id matching NEITHER a Solana signature, a TON tx hash, NOR a FEE_SWEEP/REFUND
  //     child suffix (e.g. a bare token): no source re-read applies, so the dispatcher must
  //     FAIL CLOSED (regression guard for the silent-bypass hole). FEE_SWEEP/REFUND
  //     validation itself is exercised in tools/fee-sweep-refund-spike.cjs.
  {
    const action = canonicalPegOut({ ...trueBurn, sourceId: "not-a-known-shape", homeDestination: VIZ_ACCT });
    await expectReject(validateAction(action, depsPegOut({ ...trueBurn, sourceId: "not-a-known-shape" }, aliceRec)), "6d unknown-shape PEG_OUT refused (fail-closed)");
  }

  if (failures > 0) {
    console.error(`\nRESULT: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nRESULT: F2 source validation rejects forged peg-in/peg-out actions;");
  console.log("PDA-based deposit binding re-derives addresses trustlessly (no secret needed).");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
