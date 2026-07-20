import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore, SqliteGatewayStore, type GatewayStore } from "../src/store";
import type { ActionStatus } from "../src/idempotency";
import type { RemoteChainId } from "../src/types";

// Edge cases for minPegInFeeMilliViz — the query behind recon's rate-independent
// sanity floor. The invariant under test: it returns the smallest PINNED (fee > 0)
// fee among BROADCAST/CONFIRMED PEG_IN rows, and treats fee 0 as "not yet pinned"
// (a BROADCAST row mid-mint, or a recovery-path CONFIRMED row) rather than a real
// under-pin. Run against BOTH store implementations so the SQLite production path
// and the in-memory test path stay in lockstep.

const STORES: Array<[string, () => GatewayStore]> = [
  ["InMemory", () => new InMemoryGatewayStore()],
  ["SQLite", () => new SqliteGatewayStore(":memory:")],
];

async function addPegIn(
  store: GatewayStore,
  id: string,
  chain: RemoteChainId,
  status: ActionStatus,
  fee: bigint,
  amount = 1_000_000n,
): Promise<void> {
  await store.enqueue({ id, direction: "PEG_IN", remoteChain: chain, recipient: "u", amountMilliViz: amount, digest: `d-${id}` });
  if (status !== "QUEUED") await store.setStatus(id, status);
  if (fee > 0n) await store.setFee(id, fee);
}

for (const [label, make] of STORES) {
  test(`[${label}] empty store -> null`, async () => {
    assert.equal(await make().minPegInFeeMilliViz("GRAM"), null);
  });

  test(`[${label}] single CONFIRMED positive fee -> that fee`, async () => {
    const store = make();
    await addPegIn(store, "a", "GRAM", "CONFIRMED", 45_000n);
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), 45_000n);
  });

  test(`[${label}] BROADCAST row with unpinned fee 0 -> null (excluded)`, async () => {
    const store = make();
    await addPegIn(store, "bc", "GRAM", "BROADCAST", 0n); // mid-mint, fee not pinned yet
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), null);
  });

  test(`[${label}] recovery-path CONFIRMED row with fee 0 -> null (excluded)`, async () => {
    const store = make();
    await addPegIn(store, "rec", "GRAM", "CONFIRMED", 0n); // coordinator reported fee 0
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), null);
  });

  test(`[${label}] fee 0 alongside positives -> smallest POSITIVE (0 ignored)`, async () => {
    const store = make();
    await addPegIn(store, "z", "GRAM", "BROADCAST", 0n);
    await addPegIn(store, "p1", "GRAM", "CONFIRMED", 84_000n);
    await addPegIn(store, "p2", "GRAM", "CONFIRMED", 45_000n);
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), 45_000n);
  });

  test(`[${label}] genuine under-pin (small positive) still surfaces past a fee-0 row`, async () => {
    const store = make();
    await addPegIn(store, "z", "GRAM", "BROADCAST", 0n); // must not mask the real mis-pin
    await addPegIn(store, "bad", "GRAM", "CONFIRMED", 100n);
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), 100n);
  });

  test(`[${label}] QUEUED / REFUNDED / REFUNDING rows are never counted`, async () => {
    const store = make();
    await addPegIn(store, "q", "GRAM", "QUEUED", 999n); // not minted
    await addPegIn(store, "rf", "GRAM", "REFUNDED", 0n);
    await addPegIn(store, "rg", "GRAM", "REFUNDING", 30_000n);
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), null);
  });

  test(`[${label}] chain filter: fee-0 GRAM + positive SOLANA`, async () => {
    const store = make();
    await addPegIn(store, "g0", "GRAM", "BROADCAST", 0n);
    await addPegIn(store, "s1", "SOLANA", "CONFIRMED", 10_000n);
    assert.equal(await store.minPegInFeeMilliViz("GRAM"), null, "GRAM has no pinned fee");
    assert.equal(await store.minPegInFeeMilliViz("SOLANA"), 10_000n);
    // Global query (no chain) still excludes the fee-0 GRAM row.
    assert.equal(await store.minPegInFeeMilliViz(), 10_000n);
  });

  test(`[${label}] global query returns smallest positive across chains`, async () => {
    const store = make();
    await addPegIn(store, "g", "GRAM", "CONFIRMED", 45_000n);
    await addPegIn(store, "s", "SOLANA", "CONFIRMED", 8_000n);
    assert.equal(await store.minPegInFeeMilliViz(), 8_000n);
  });
}
