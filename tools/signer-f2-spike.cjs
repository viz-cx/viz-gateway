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
  depositAta,
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
  const FAKE_MINT = "So11111111111111111111111111111111111111112"; // any valid pubkey
  const VIZ_ACCT = "alice";
  const ALICE_ATA = depositAta(FAKE_PROGRAM_ID, VIZ_ACCT, FAKE_MINT);
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
    destinationValid: true,
  };

  // Mock chain readers / store. Each test swaps in the relevant behavior.
  const vizChainReturning = (deposit) => ({ getDeposit: async () => deposit });
  const solanaReturning = (burn) => ({ getBurn: async () => burn });

  const FEES = {
    floorMilliViz: 10_000n,
    bps: 20,
    activationSurchargeMilliViz: { SOLANA: 10_000n, GRAM: 10_000n },
    mintGasFloorMilliViz: { SOLANA: 1_000n, GRAM: 1_000n },
  };
  const FEES_GATE = "fees.gate";

  const depsPegIn = (deposit) => ({
    vizChain: vizChainReturning(deposit),
    solanaChain: { getDepositTransfer: async () => null },
    tonChain: solanaReturning(null),
    depositProgramId: FAKE_PROGRAM_ID,
    wvizMint: FAKE_MINT,
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

  // 3d) NEVER-MINT guarantee: a no-memo / invalid-destination deposit is un-mintable even though
  //     getDeposit now RETURNS it (destinationValid=false, remoteDestination="") instead of
  //     throwing. validatePegIn must hard-reject on the destinationValid flag — the security
  //     control relocated from the reader to the trust layer. This is the auto-return invariant.
  {
    const noMemo = { ...trueDeposit, remoteDestination: "", destinationValid: false };
    const action = canonicalPegIn(noMemo); // recipient="" — the canonical destination-less action
    await expectReject(validateAction(action, depsPegIn(noMemo)), "3d no-memo PEG_IN never mintable");
  }

  // 3e) Coordinator forges a PEG_IN with a FABRICATED memo: the wire action claims a real-looking
  //     recipient, but the operator's OWN node read yields destinationValid=false (the on-chain memo
  //     was empty/malformed). The re-read wins — refuse to mint a destination the source never had.
  {
    const fabricated = canonicalPegIn({ ...trueDeposit, remoteDestination: SOL_RECIPIENT }); // looks valid on the wire
    const sourceNoMemo = { ...trueDeposit, remoteDestination: "", destinationValid: false }; // truth from the node
    await expectReject(validateAction(fabricated, depsPegIn(sourceNoMemo)), "3e forged-memo PEG_IN rejected");
  }

  // =========================== PEG_OUT (Solana) =================================

  // Registry-free deposit-event validation (2026-08-28 fix): the action id is the
  // finalized wVIZ TRANSFER signature into the burn-only deposit ATA (the pegout
  // scanner's sourceId), NOT a burn tx. The validator re-derives the ATA from
  // action.recipient + its OWN program/mint pins and requires the transfer to credit
  // exactly that ATA — the derivation IS the binding; no registry row is consulted.
  const AMOUNT = 500_000n;

  // The TRUE transfer the operator's own Solana node would return, keyed by (sig, ata).
  const solanaWithDeposit = (sig, ata, amountBaseUnits) => ({
    getDepositTransfer: async (id, dep) => (id === sig && dep === ata ? { slot: 1234, amountBaseUnits } : null),
  });
  const trueBurn = (homeDestination) => ({
    chain: "SOLANA",
    sourceId: SOL_SIG,
    height: 1234,
    from: ALICE_ATA,
    amountMilliViz: AMOUNT,
    homeDestination,
  });
  const depsPegOut = (reader) => ({
    vizChain: vizChainReturning(null),
    solanaChain: reader,
    tonChain: solanaReturning(null),
    depositProgramId: FAKE_PROGRAM_ID,
    wvizMint: FAKE_MINT,
    fees: FEES,
    feesGateAccount: FEES_GATE,
  });
  const honestReader = () => solanaWithDeposit(SOL_SIG, ALICE_ATA, AMOUNT);

  // 4) Honest PEG_OUT Solana: transfer into alice's derived ATA, release to alice -> passes.
  {
    const action = canonicalPegOut(trueBurn(VIZ_ACCT));
    await validateAction(action, depsPegOut(honestReader()));
    ok("4 honest PEG_OUT Solana: deposit transfer binds to alice -> signs");
  }

  // 5) Tampered PEG_OUT recipient: coordinator redirects alice's deposit to "bob"; the
  //    validator derives BOB's ATA, finds no transfer there -> rejected.
  {
    const tampered = canonicalPegOut(trueBurn("bob"));
    await expectReject(validateAction(tampered, depsPegOut(honestReader())), "5 tampered PEG_OUT recipient");
  }

  // 5b) Tampered PEG_OUT amount: real transfer, inflated release -> rejected.
  {
    const tampered = canonicalPegOut({ ...trueBurn(VIZ_ACCT), amountMilliViz: AMOUNT * 2n });
    await expectReject(validateAction(tampered, depsPegOut(honestReader())), "5b tampered PEG_OUT amount");
  }

  // 6) Transfer not found / not finalized (getDepositTransfer -> null): fail-closed reject.
  {
    const action = canonicalPegOut(trueBurn(VIZ_ACCT));
    await expectReject(validateAction(action, depsPegOut({ getDepositTransfer: async () => null })), "6 PEG_OUT deposit not finalized");
  }

  // 6b) Missing wVIZ-mint pin: the ATA cannot be derived, so refuse outright (fail-closed).
  {
    const action = canonicalPegOut(trueBurn(VIZ_ACCT));
    const deps = depsPegOut(honestReader());
    deps.wvizMint = "";
    await expectReject(validateAction(action, deps), "6b PEG_OUT without a wVIZ-mint pin");
  }

  // 6c) TON-shaped PEG_OUT id (64-hex burn tx hash) but the operator's TON node has no such
  //     burn (getBurn -> null): the TON branch fails closed. Full TON validation is exercised
  //     in tools/gram-pegout-f2-spike.cjs; here we just prove the dispatch + fail-closed path.
  {
    const tonHash = "a".repeat(64); // 64-hex burn tx hash — routes to the TON branch
    const action = canonicalPegOut({ ...trueBurn(VIZ_ACCT), sourceId: tonHash });
    await expectReject(validateAction(action, depsPegOut(honestReader())), "6c TON PEG_OUT burn not final (fail-closed)");
  }

  // 6d) An id matching NEITHER a Solana signature, a TON tx hash, NOR a FEE_SWEEP/REFUND
  //     child suffix (e.g. a bare token): no source re-read applies, so the dispatcher must
  //     FAIL CLOSED (regression guard for the silent-bypass hole). FEE_SWEEP/REFUND
  //     validation itself is exercised in tools/fee-sweep-refund-spike.cjs.
  {
    const action = canonicalPegOut({ ...trueBurn(VIZ_ACCT), sourceId: "not-a-known-shape" });
    await expectReject(validateAction(action, depsPegOut(honestReader())), "6d unknown-shape PEG_OUT refused (fail-closed)");
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
