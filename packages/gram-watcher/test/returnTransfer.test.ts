import { test } from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { buildReturnTransfer, returnOrderCell } from "../src/gramChain";

const GATEWAY_JW = new Address(0, Buffer.alloc(32, 0x01));
const SENDER = new Address(0, Buffer.alloc(32, 0x02));

test("buildReturnTransfer targets the gateway jetton wallet with a TEP-74 transfer op", () => {
  const t = buildReturnTransfer(GATEWAY_JW, SENDER, 12345n);
  assert.equal(t.type, "transfer");
  assert.ok(t.message.info.type === "internal");
  assert.ok((t.message.info as { dest: Address }).dest.equals(GATEWAY_JW));
  const body = t.message.body.beginParse();
  assert.equal(body.loadUint(32), 0x0f8a7ea5); // TEP-74 transfer
  body.loadUintBig(64); // query_id
  assert.equal(body.loadCoins(), 12345n);
  assert.ok(body.loadAddress().equals(SENDER)); // destination
});

test("returnOrderCell hash is deterministic for identical inputs", () => {
  const a = returnOrderCell(GATEWAY_JW, SENDER, 999n).hashHex;
  const b = returnOrderCell(GATEWAY_JW, SENDER, 999n).hashHex;
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, returnOrderCell(GATEWAY_JW, SENDER, 1000n).hashHex); // amount-sensitive
});
