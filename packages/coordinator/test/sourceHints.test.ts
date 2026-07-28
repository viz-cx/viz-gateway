import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryGatewayStore, type CanonicalAction, type EnqueueInput } from "@gateway/common";
import {
  loadSourceHints,
  parentPegInIdOf,
  resolveSourceHint,
  applySourceHintResolutions,
} from "../src/sourceHints";

const PARENT_ID = "779ffb0d9efc79e6d1a9bb21bf645534bb93d0f7:0";
const BLOCK = 81976371;

function writeHints(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "src-hints-"));
  const path = join(dir, "source-hints.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  return path;
}

// ---- loader / validation ----

test("loadSourceHints parses a valid directive and lowercases the key", () => {
  const path = writeHints({ [PARENT_ID.toUpperCase()]: { sourceBlockNum: BLOCK, resolution: "mint" } });
  const hints = loadSourceHints(path);
  assert.deepEqual(hints[PARENT_ID], { sourceBlockNum: BLOCK, resolution: "mint" });
});

test("loadSourceHints fail-closed: missing file / non-object / bad entries -> dropped", () => {
  assert.deepEqual(loadSourceHints(join(tmpdir(), "does-not-exist-xyz.json")), {});
  assert.deepEqual(loadSourceHints(writeHints("[1,2,3]")), {});
  assert.deepEqual(loadSourceHints(writeHints("{ not json")), {});
  // Invalid entries are individually skipped.
  const path = writeHints({
    good: { sourceBlockNum: 5 },
    badBlock: { sourceBlockNum: -1 },
    badBlock2: { sourceBlockNum: 1.5 },
    badRes: { resolution: "burn" },
    notObj: 42,
  });
  assert.deepEqual(loadSourceHints(path), { good: { sourceBlockNum: 5 } });
});

// ---- parentPegInIdOf ----

test("parentPegInIdOf maps PEG_IN + REFUND/FEE children to the parent, others to null", () => {
  const mk = (direction: string, id: string): CanonicalAction => ({ direction: direction as CanonicalAction["direction"], id, recipient: "", amountMilliViz: 0n, digest: "" });
  assert.equal(parentPegInIdOf(mk("PEG_IN", PARENT_ID)), PARENT_ID);
  assert.equal(parentPegInIdOf(mk("REFUND", `${PARENT_ID}:refund`)), PARENT_ID);
  assert.equal(parentPegInIdOf(mk("FEE_SWEEP", `${PARENT_ID}:fee`)), PARENT_ID);
  assert.equal(parentPegInIdOf(mk("PEG_OUT", "ab".repeat(32))), null);
  assert.equal(parentPegInIdOf(mk("GRAM_RETURN", `${"ab".repeat(32)}:return`)), null);
});

// ---- resolveSourceHint precedence: DB block_num over file ----

const pegIn = (id: string, blockNum?: number): EnqueueInput => ({
  id, direction: "PEG_IN", remoteChain: "GRAM", recipient: "UQ", amountMilliViz: 100_000n, digest: "d", status: "REFUNDING", blockNum,
});
const refundAction: CanonicalAction = { direction: "REFUND" as CanonicalAction["direction"], id: `${PARENT_ID}:refund`, recipient: "kristi", amountMilliViz: 95_000n, digest: "d:refund" };

test("resolveSourceHint: DB block_num wins; file supplies it only when DB is NULL", async () => {
  const hints = { [PARENT_ID]: { sourceBlockNum: 999 } };

  const dbHas = new InMemoryGatewayStore();
  await dbHas.enqueue(pegIn(PARENT_ID, BLOCK));
  assert.deepEqual(await resolveSourceHint(refundAction, dbHas, hints), { sourceBlockNum: BLOCK }, "DB value wins over the file");

  const dbNull = new InMemoryGatewayStore();
  await dbNull.enqueue(pegIn(PARENT_ID)); // block_num NULL (pre-column row)
  assert.deepEqual(await resolveSourceHint(refundAction, dbNull, hints), { sourceBlockNum: 999 }, "file supplies the hint when DB is NULL");

  const dbEmpty = new InMemoryGatewayStore();
  assert.equal(await resolveSourceHint(refundAction, dbEmpty, {}), undefined, "no DB row + no file -> no hint");
});

// ---- applySourceHintResolutions: run-once redirect, guards, pause-gating ----

async function seedStuck(): Promise<InMemoryGatewayStore> {
  const store = new InMemoryGatewayStore();
  await store.enqueue(pegIn(PARENT_ID)); // parent REFUNDING (mint failed)
  await store.enqueue({ id: `${PARENT_ID}:refund`, direction: "REFUND", remoteChain: "GRAM", recipient: "kristi", amountMilliViz: 95_000n, digest: "d:refund", status: "QUEUED", parentId: PARENT_ID });
  return store;
}
const mintHints = { [PARENT_ID]: { sourceBlockNum: BLOCK, resolution: "mint" as const } };

test("redirect refuses to run while the gateway is NOT paused (no state change)", async () => {
  const store = await seedStuck();
  await applySourceHintResolutions(store, mintHints);
  assert.equal((await store.get(PARENT_ID))!.status, "REFUNDING", "parent untouched when unpaused");
  assert.equal((await store.get(`${PARENT_ID}:refund`))!.status, "QUEUED", "child untouched when unpaused");
});

test("redirect (paused): abandons the refund child + re-drives the parent to QUEUED, once", async () => {
  const store = await seedStuck();
  await store.pause("deploy");
  await applySourceHintResolutions(store, mintHints);
  assert.equal((await store.get(PARENT_ID))!.status, "QUEUED", "parent re-driven to mint");
  assert.equal((await store.get(`${PARENT_ID}:refund`))!.status, "FAILED", "refund child abandoned");
  assert.ok(await store.getState(`source-hint-applied:${PARENT_ID}`), "run-once marker set");

  // Idempotent: a second run (e.g. restart) is a no-op even if the parent moved on.
  await store.setStatus(PARENT_ID, "CONFIRMED");
  await applySourceHintResolutions(store, mintHints);
  assert.equal((await store.get(PARENT_ID))!.status, "CONFIRMED", "re-run must not touch a now-minted parent");
});

test("double-pay guard: never mint when the refund child already CONFIRMED (or has a txid)", async () => {
  const store = await seedStuck();
  await store.pause("deploy");
  await store.setStatus(`${PARENT_ID}:refund`, "CONFIRMED"); // refund already delivered
  await applySourceHintResolutions(store, mintHints);
  assert.equal((await store.get(PARENT_ID))!.status, "REFUNDING", "must NOT re-drive to mint (would double-pay)");
  assert.ok(await store.getState(`source-hint-applied:${PARENT_ID}`), "marked done (no-op) so it never retries");
});

test("resolution omitted/refund is a no-op (today's default behaviour)", async () => {
  const store = await seedStuck();
  await store.pause("deploy");
  await applySourceHintResolutions(store, { [PARENT_ID]: { sourceBlockNum: BLOCK, resolution: "refund" } });
  assert.equal((await store.get(PARENT_ID))!.status, "REFUNDING", "refund directive changes nothing");
  await applySourceHintResolutions(store, { [PARENT_ID]: { sourceBlockNum: BLOCK } });
  assert.equal((await store.get(PARENT_ID))!.status, "REFUNDING", "omitted resolution changes nothing");
});
