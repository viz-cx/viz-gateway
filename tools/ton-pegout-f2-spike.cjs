// SPIKE: F2 — the signer's INDEPENDENT source-event validation for TON peg-out (offline).
//
// Proves that the signer re-reads a TON burn from its OWN node view (a bounded scan of the
// gateway jetton wallet's transactions, matched by tx hash) and asserts byte-identical
// equality with the coordinator-supplied action. A compromised coordinator that hands over a
// self-consistent action for a tampered/absent/not-yet-final burn is REJECTED. Unlike Solana,
// TON needs no deposit-address registry: the VIZ recipient is the on-chain transfer comment,
// which the operator's node returns directly in the burn.
//
// Run (after `npm run build`): node tools/ton-pegout-f2-spike.cjs
const assert = require("node:assert");
const { beginCell, Address } = require("@ton/ton");
const { canonicalPegOut } = require("@gateway/common");
const { TonHttpChain } = require("../packages/ton-watcher/dist/tonChain.js");
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

// --- fixtures ------------------------------------------------------------------
const SENDER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"; // wVIZ burner
// Raw address form (workchain:hex) — accepted by Address.parse without a checksum.
const GATEWAY_WALLET = "0:" + "1".repeat(64); // gateway jetton wallet
const MINTER = "0:" + "0".repeat(64); // jetton minter (unused by getBurn)
const AMOUNT = 500_000n; // base units == milli-VIZ (3 decimals)
const COMMENT = "alice"; // the VIZ recipient, carried in the transfer comment
const BURN_HASH = "b1".repeat(32); // 64-hex burn tx hash == the peg-out action.id

// A TEP-74 internal_transfer body (0x178d4519) — the message the gateway's OWN jetton
// wallet actually receives for an inbound transfer (forward_payload inline text comment).
function internalTransferBody(amount, comment, sender) {
  return beginCell()
    .storeUint(0x178d4519, 32) // internal_transfer
    .storeUint(0, 64) // query_id
    .storeCoins(amount)
    .storeAddress(Address.parse(sender)) // from
    .storeAddress(Address.parse(sender)) // response_address
    .storeCoins(50000000n) // forward_ton_amount
    .storeBit(0) // inline forward_payload
    .storeUint(0, 32) // comment tag
    .storeStringTail(comment)
    .endCell();
}

function makeTx(hashHex, nowSec, body) {
  return {
    hash: () => Buffer.from(hashHex, "hex"),
    now: nowSec,
    inMessage: { body },
  };
}

// A mock TonClient injected over the private `client` field: getBurn only calls
// getTransactions + getMasterchainInfo.
function mockClient(txs) {
  return {
    getTransactions: async () => txs,
    getMasterchainInfo: async () => ({ latestSeqno: 999 }),
  };
}

// Construct a read-only TonHttpChain (no mnemonic/multisig) and swap in the mock client.
function tonChainWith(txs) {
  const chain = new TonHttpChain(
    "https://example.invalid", // endpoint (unused; client is mocked)
    "", // apiKey
    MINTER,
    GATEWAY_WALLET,
    "", // multisigAddress (order reads unused in this peg-out F2 read-path test)
    1, // finalityConfirmations -> ~10s buffer
    20, // scanMaxTransactions
  );
  chain.client = mockClient(txs);
  return chain;
}

const FEES = {
  floorMilliViz: 10_000n,
  bps: 20,
  activationSurchargeMilliViz: { SOLANA: 10_000n, TON: 10_000n },
  mintGasFloorMilliViz: { SOLANA: 1_000n, TON: 1_000n },
};
const FEES_GATE = "fees.gate";
const FAKE_PROGRAM_ID = "GateWayDep1111111111111111111111111111111111";

const depsWith = (chain) => ({
  vizChain: { getDeposit: async () => null },
  solanaChain: { getBurn: async () => null },
  tonChain: chain,
  store: { depositAddressBy: async () => undefined },
  fees: FEES,
  feesGateAccount: FEES_GATE,
  depositProgramId: FAKE_PROGRAM_ID,
});

(async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const finalNow = nowSec - 100; // well past the ~10s finality buffer
  const notFinalNow = nowSec + 5; // inside the buffer -> not yet final

  // The TRUE burn the operator's own node would re-derive.
  const trueTx = makeTx(BURN_HASH, finalNow, internalTransferBody(AMOUNT, COMMENT, SENDER));

  // 1) getBurn returns the on-chain burn for a matching hash.
  {
    const burn = await tonChainWith([trueTx]).getBurn(BURN_HASH);
    assert.ok(burn, "getBurn returned null for a final matching tx");
    assert.strictEqual(burn.sourceId, BURN_HASH, "sourceId == tx hash");
    assert.strictEqual(burn.amountMilliViz, AMOUNT, "amount");
    assert.strictEqual(burn.homeDestination, COMMENT, "recipient == comment");
    ok("1 getBurn re-reads the burn (hash, amount, comment) from the node view");
  }

  // 2) Honest PEG_OUT: coordinator action matches the re-read burn exactly -> signs.
  {
    const burn = await tonChainWith([trueTx]).getBurn(BURN_HASH);
    const action = canonicalPegOut(burn);
    await validateAction(action, depsWith(tonChainWith([trueTx])));
    ok("2 honest TON PEG_OUT: source-derived action matches -> signs");
  }

  // 3) Tampered amount: coordinator inflates the release -> rejected.
  {
    const burn = await tonChainWith([trueTx]).getBurn(BURN_HASH);
    const tampered = canonicalPegOut({ ...burn, amountMilliViz: 999_999_999n });
    await expectReject(validateAction(tampered, depsWith(tonChainWith([trueTx]))), "3 tampered TON amount");
  }

  // 4) Tampered recipient: coordinator redirects the release to "bob" -> rejected.
  {
    const burn = await tonChainWith([trueTx]).getBurn(BURN_HASH);
    const tampered = canonicalPegOut({ ...burn, homeDestination: "bob" });
    await expectReject(validateAction(tampered, depsWith(tonChainWith([trueTx]))), "4 tampered TON recipient");
  }

  // 5) Unknown burn: action.id (TON-shaped) matches no tx in the scan window -> null -> reject.
  {
    const ghostHash = "cc".repeat(32);
    const action = canonicalPegOut({
      sourceId: ghostHash,
      height: 0,
      from: SENDER,
      amountMilliViz: AMOUNT,
      homeDestination: COMMENT,
    });
    await expectReject(validateAction(action, depsWith(tonChainWith([trueTx]))), "5 unknown TON burn (not in window)");
  }

  // 6) Not-yet-final burn: the matching tx is inside the finality buffer -> null -> reject.
  {
    const freshTx = makeTx(BURN_HASH, notFinalNow, internalTransferBody(AMOUNT, COMMENT, SENDER));
    const action = canonicalPegOut({
      sourceId: BURN_HASH,
      height: 0,
      from: SENDER,
      amountMilliViz: AMOUNT,
      homeDestination: COMMENT,
    });
    await expectReject(validateAction(action, depsWith(tonChainWith([freshTx]))), "6 TON burn not yet final");
  }

  if (failures > 0) {
    console.error(`\nRESULT: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nRESULT: TON peg-out F2 re-reads the burn from the operator's own node view and");
  console.log("rejects tampered/absent/not-final burns; honest burns validate byte-identically.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
