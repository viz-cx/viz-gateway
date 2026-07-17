import { test } from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { assertReturnOrderHash } from "../src/gramApprove";
import { returnOrderCell } from "../src/gramChain";

// Use raw Address construction to avoid checksum validation issues with dummy addresses.
const JW = new Address(0, Buffer.alloc(32, 0x01));
const TO = new Address(0, Buffer.alloc(32, 0x02));

test("assertReturnOrderHash throws on a tampered hash", () => {
  assert.throws(() => assertReturnOrderHash(JW, TO, 1000n, "deadbeef"), /order hash mismatch/i);
});

test("assertReturnOrderHash passes for the real rebuilt hash", () => {
  const { hashHex } = returnOrderCell(JW, TO, 1000n);
  assert.doesNotThrow(() => assertReturnOrderHash(JW, TO, 1000n, hashHex));
});
