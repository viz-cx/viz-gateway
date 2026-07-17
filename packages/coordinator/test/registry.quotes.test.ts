import { test } from "node:test";
import assert from "node:assert/strict";
import { SignerRegistry } from "../src/registry";

test("liveQuotes returns quotes from live registrations only", () => {
  let now = 1000;
  const reg = new SignerRegistry(
    [{ id: "op-1", vizPubkey: "", tonPubkey: "", solanaPubkey: "" }],
    60000, 30000, () => now,
  );
  // Nobody registered yet — liveQuotes returns empty.
  assert.deepEqual(reg.liveQuotes(), []);
});
