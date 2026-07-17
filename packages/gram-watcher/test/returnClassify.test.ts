import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPegOutDestination } from "../src/returnClassify";

const exists = (set: Set<string>) => async (n: string) => set.has(n);

test("existing account -> usable (release proceeds)", async () => {
  assert.equal(await classifyPegOutDestination("alice", exists(new Set(["alice"]))), "");
});
test("non-existent account -> RETURN_INVALID_DEST", async () => {
  assert.equal(await classifyPegOutDestination("ghost", exists(new Set())), "RETURN_INVALID_DEST");
});
test("empty/whitespace destination -> RETURN_INVALID_DEST", async () => {
  // accountExists("") is false in the real VizChain; model that here.
  const ae = async (n: string) => n.trim().length > 0 && n === "alice";
  assert.equal(await classifyPegOutDestination("", ae), "RETURN_INVALID_DEST");
  assert.equal(await classifyPegOutDestination("   ", ae), "RETURN_INVALID_DEST");
});
