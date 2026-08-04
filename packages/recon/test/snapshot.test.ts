import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore, parseReconSnapshot, reconSnapshotKey } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

const readSnapshot = async (store: InMemoryGatewayStore, chain = "GRAM") =>
  parseReconSnapshot(await store.getState(reconSnapshotKey(chain)));

test("a healthy check publishes the exact figures it reconciled", async () => {
  const store = new InMemoryGatewayStore();
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 43_500_000n }],
    async () => 43_547_500n, // over-backed by the structural 47.5 VIZ surplus
    store,
    cfg,
    "GRAM",
  );

  assert.equal(await gram.check(), true);
  const snap = await readSnapshot(store);
  assert.equal(snap?.chain, "GRAM");
  assert.equal(snap?.lockedMilliViz, 43_547_500n);
  assert.equal(snap?.circulatingMilliViz, 43_500_000n);
  assert.equal(snap?.unsweptFeesMilliViz, 0n);
  assert.equal(snap?.driftMilliViz, 47_500n, "drift = locked − (circulating + unswept)");
  assert.equal(snap?.status, "OK");
  assert.ok((snap?.checkedAt ?? 0) > 0);
});

test("an under-backed check still pauses, and publishes UNDER_BACKED", async () => {
  const store = new InMemoryGatewayStore();
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 50_000_000n }],
    async () => 40_000_000n,
    store,
    cfg,
    "GRAM",
  );

  assert.equal(await gram.check(), false);
  assert.ok(await store.isPaused(), "the pause is the product — snapshot must not displace it");
  const snap = await readSnapshot(store);
  assert.equal(snap?.status, "UNDER_BACKED");
  assert.equal(snap?.driftMilliViz, -10_000_000n);
});

test("an INDETERMINATE check leaves the previous snapshot untouched", async () => {
  const store = new InMemoryGatewayStore();
  // Tick 1: healthy, publishes a snapshot.
  const healthy = new Recon(
    [{ name: "GRAM", supply: async () => 1_000n }],
    async () => 1_000n,
    store,
    cfg,
    "GRAM",
  );
  assert.equal(await healthy.check(), true);
  const before = await readSnapshot(store);
  assert.equal(before?.lockedMilliViz, 1_000n);

  // Tick 2: the supply read fails. A substituted figure here is exactly the class of bug
  // PR #122 closed, so the endpoint must keep serving the older-but-true snapshot.
  const blind = new Recon(
    [{ name: "GRAM", supply: async () => { throw new Error("toncenter timeout"); } }],
    async () => 9_999_999n,
    store,
    cfg,
    "GRAM",
  );
  assert.equal(await blind.check(), null);
  assert.deepEqual(await readSnapshot(store), before, "indeterminate must not overwrite");

  // Tick 3: the locked read fails instead — same rule.
  const blind2 = new Recon(
    [{ name: "GRAM", supply: async () => 1_000n }],
    async () => { throw new Error("VIZ node empty read"); },
    store,
    cfg,
    "GRAM",
  );
  assert.equal(await blind2.check(), null);
  assert.deepEqual(await readSnapshot(store), before);
});

test("a failing snapshot write cannot change the check result", async () => {
  const store = new InMemoryGatewayStore();
  let attempted = false;
  store.setState = async () => {
    attempted = true;
    throw new Error("disk full");
  };

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 1_000n }],
    async () => 1_000n,
    store,
    cfg,
    "GRAM",
  );

  assert.equal(await gram.check(), true, "a display-only write must not degrade the verdict");
  assert.ok(attempted);
  assert.equal(await store.isPaused(), false);
});

test("an under-backed check pauses even when the snapshot write throws", async () => {
  const store = new InMemoryGatewayStore();
  store.setState = async () => { throw new Error("disk full"); };

  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 5_000n }],
    async () => 1_000n,
    store,
    cfg,
    "GRAM",
  );

  assert.equal(await gram.check(), false);
  assert.ok(await store.isPaused(), "pause ordering must not depend on the KV write");
});

test("snapshots are per chain and do not collide", async () => {
  const store = new InMemoryGatewayStore();
  await new Recon([{ name: "GRAM", supply: async () => 10n }], async () => 10n, store, cfg, "GRAM").check();
  await new Recon([{ name: "SOLANA", supply: async () => 20n }], async () => 20n, store, cfg, "SOLANA").check();

  assert.equal((await readSnapshot(store, "GRAM"))?.circulatingMilliViz, 10n);
  assert.equal((await readSnapshot(store, "SOLANA"))?.circulatingMilliViz, 20n);
});

test("a chain-less Recon publishes under the ALL key", async () => {
  const store = new InMemoryGatewayStore();
  await new Recon([{ name: "GRAM", supply: async () => 7n }], async () => 7n, store, cfg).check();
  assert.equal((await readSnapshot(store, "ALL"))?.chain, "ALL");
});
