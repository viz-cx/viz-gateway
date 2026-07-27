import { test } from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/ton";
import { GramApprover, encodeReceipt, assertReturnOrderHash } from "../src/gramApprove";
import { returnOrderCell } from "../src/gramChain";

// The GramApprover send path is proven end-to-end by the sandbox spikes; here we lock its
// pure surface and fail-closed constructor guards (the config-error boundary that must never
// silently construct a keyless/mis-wired approver).

const ZERO = "0:" + "0".repeat(64);
const ONE = "0:" + "1".repeat(64);
const MNEMONIC = "test ".repeat(24).trim(); // shape only — never used for a real send here
const ENDPOINTS = ["https://toncenter.com/api/v2/jsonRPC", "https://ton.access.orbs.network/x/1/mainnet/toncenter-api-v2/jsonRPC"];

test("encodeReceipt packs the receipt into the ton:addr:idx:role slot", () => {
  assert.equal(
    encodeReceipt({ orderAddr: "EQxyz", myIdx: 2, role: "approve" }),
    "ton:EQxyz:2:approve",
  );
});

test("assertReturnOrderHash: matching hash passes, mismatch fails closed", () => {
  const gw = Address.parse(ZERO);
  const to = Address.parse(ONE);
  const amount = 42_000n;
  const { hashHex } = returnOrderCell(gw, to, amount);
  assert.doesNotThrow(() => assertReturnOrderHash(gw, to, amount, hashHex));
  assert.throws(
    () => assertReturnOrderHash(gw, to, amount, "deadbeef"),
    /return order hash mismatch/,
    "a wrong proposal hash must throw (binds recipient+amount)",
  );
  // A different amount reshapes the order -> the pinned hash no longer matches.
  assert.throws(() => assertReturnOrderHash(gw, to, amount + 1n, hashHex), /return order hash mismatch/);
});

test("constructor fails closed on missing minter / multisig / mnemonic", () => {
  assert.throws(
    () => new GramApprover(ENDPOINTS, "", "", ZERO, MNEMONIC, Address.parse(ZERO)),
    /minter address is required/,
  );
  assert.throws(
    () => new GramApprover(ENDPOINTS, "", ZERO, "", MNEMONIC, Address.parse(ZERO)),
    /GRAM_MULTISIG_ADDRESS is required/,
  );
  assert.throws(
    () => new GramApprover(ENDPOINTS, "", ZERO, ZERO, "", Address.parse(ZERO)),
    /GRAM_SIGNER_MNEMONIC is required/,
  );
});

test("constructor builds one client per endpoint from a list or a bare string", () => {
  // A fully-specified approver constructs without a network call; buildTonClients runs here.
  const many = new GramApprover(ENDPOINTS, "key", ZERO, ZERO, MNEMONIC, Address.parse(ZERO));
  const one = new GramApprover(ENDPOINTS[0]!, "key", ZERO, ZERO, MNEMONIC, Address.parse(ZERO));
  assert.equal((many as unknown as { clients: unknown[] }).clients.length, 2);
  assert.equal((one as unknown as { clients: unknown[] }).clients.length, 1);
});
