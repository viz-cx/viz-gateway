import { test } from "node:test";
import assert from "node:assert/strict";
import type { Transaction } from "@ton/core";
import { txComputeSucceeded } from "../src/gramChain";

// SECURITY: burnFromTx builds a peg-out release purely from an inbound message body. Anyone can
// send a hand-crafted internal_transfer / transfer_notification to the gateway's public jetton
// wallet with an attacker-chosen amount, `from`, and comment. The standard TEP-74 wallet REJECTS
// it (the sender is not a genuine peer jetton wallet), so the tx ABORTS in compute and moves zero
// wVIZ — but it still lands on the account and is returned by getTransactions. txComputeSucceeded
// is the gate that separates a real, committed inbound transfer from such a rejected forgery;
// without it a single ~0.005 TON message drains the VIZ backing.

const desc = (d: unknown): Transaction => ({ description: d } as unknown as Transaction);

test("committed inbound transfer (compute vm success) is accepted", () => {
  assert.equal(txComputeSucceeded(desc({ type: "generic", computePhase: { type: "vm", success: true } })), true);
});

test("aborted/rejected forgery (vm success:false) is refused", () => {
  // A crafted internal_transfer from a non-wallet address: the gateway wallet throws → not credited.
  assert.equal(txComputeSucceeded(desc({ type: "generic", aborted: true, computePhase: { type: "vm", success: false } })), false);
});

test("skipped compute (no gas / frozen) is refused — nothing executed, nothing credited", () => {
  assert.equal(txComputeSucceeded(desc({ type: "generic", computePhase: { type: "skipped", reason: "no_gas" } })), false);
});

test("non-generic transaction (tick-tock / storage) is refused", () => {
  assert.equal(txComputeSucceeded(desc({ type: "storage" })), false);
});

test("missing/unparseable description is refused (fail closed, no throw)", () => {
  assert.equal(txComputeSucceeded(desc(undefined)), false);
});
