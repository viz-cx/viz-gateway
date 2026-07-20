import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// Peg-in: gross 1_000_000, pinned fee 82_500 (base 45_000 + activation 37_500).
// Circulating = gross - fee = 917_500. Locked = circulating + unswept.
// If fee fully swept: unswept = 0, locked = 917_500.
// If fee unswept:     unswept = 82_500, locked = 1_000_000.

test("balance invariant: circulating + unswept == locked (provisioned, fee fully swept)", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "p1", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "d1" });
  await store.setStatus("p1", "CONFIRMED");
  await store.setFee("p1", 82_500n);
  await store.enqueue({ id: "p1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: 82_500n, digest: "d2" });
  await store.setStatus("p1:fee", "CONFIRMED");

  // unswept = 82_500 - 82_500 = 0; circulating = 917_500; locked must be 917_500
  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 917_500n }],
    async () => 917_500n,
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), true);
  assert.equal(await store.isPaused(), false);
});

test("balance invariant: circulating + unswept == locked (unprovisioned, activation retained)", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "p2", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "d3" });
  await store.setStatus("p2", "CONFIRMED");
  await store.setFee("p2", 82_500n);
  // Only base (45_000) swept; activation (37_500) remains locked as unswept surplus.
  await store.enqueue({ id: "p2:fee", direction: "FEE_SWEEP", remoteChain: "GRAM", recipient: "fees.gate", amountMilliViz: 45_000n, digest: "d4" });
  await store.setStatus("p2:fee", "CONFIRMED");

  // unswept = 82_500 - 45_000 = 37_500; circulating = 917_500; locked = 917_500 + 37_500 = 955_000
  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 917_500n }],
    async () => 955_000n,
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), true);
  assert.equal(await store.isPaused(), false);
});

test("sanity floor breach pauses gateway", async () => {
  const store = new InMemoryGatewayStore();
  // Pinned fee is 100 mVIZ — far below sanity floor of 1_000.
  await store.enqueue({ id: "p3", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "d5" });
  await store.setStatus("p3", "CONFIRMED");
  await store.setFee("p3", 100n);

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store, cfg, "GRAM",
    1_000n, // sanity floor
  );
  assert.equal(await recon.check(), false, "sanity-floor breach must return false");
  assert.ok(await store.isPaused(), "gateway must be paused on sanity-floor breach");
});

test("sanity floor ignores recovery-path CONFIRMED peg-in with fee 0", async () => {
  const store = new InMemoryGatewayStore();
  // The coordinator's recovery path can report fee 0 (rebuild failed); planTransition
  // leaves the column at 0 rather than clobbering. That is "fee unknown", not "under-pinned".
  await store.enqueue({ id: "rec", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "drec" });
  await store.setStatus("rec", "CONFIRMED"); // fee stays default 0

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), true, "fee-0 recovery row must not trip the sanity floor");
  assert.equal(await store.isPaused(), false);
});

test("sanity floor STILL pauses on a genuine under-pin next to a fee-0 in-flight row", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "bc", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 45_000n, digest: "dbc2" });
  await store.setStatus("bc", "BROADCAST"); // fee 0, in-flight (must be ignored)
  await store.enqueue({ id: "bad", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "dbad" });
  await store.setStatus("bad", "CONFIRMED");
  await store.setFee("bad", 100n); // a real mis-pin below the floor

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), false, "the fix must not mask a genuine under-pin");
  assert.ok(await store.isPaused());
});

test("sanity floor does not pause at the exact floor (strict <)", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "edge", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "dedge" });
  await store.setStatus("edge", "CONFIRMED");
  await store.setFee("edge", 1_000n); // exactly the floor

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 1_000n, // locked == unswept fee -> drift 0
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), true, "fee == floor is within bounds");
  assert.equal(await store.isPaused(), false);
});

test("sanity floor pauses one mVIZ below the floor", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "under", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "dunder" });
  await store.setStatus("under", "CONFIRMED");
  await store.setFee("under", 999n);

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store, cfg, "GRAM", 1_000n,
  );
  assert.equal(await recon.check(), false);
  assert.ok(await store.isPaused());
});

test("no sanity floor configured skips the guard entirely", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "tiny", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 1_000_000n, digest: "dtiny" });
  await store.setStatus("tiny", "CONFIRMED");
  await store.setFee("tiny", 100n); // would breach a 1_000 floor — but none is set

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 100n, // drift 0 against the unswept 100
    store, cfg, "GRAM", // no sanity floor arg
  );
  assert.equal(await recon.check(), true, "guard must be inert when unconfigured");
  assert.equal(await store.isPaused(), false);
});

test("sanity floor ignores in-flight BROADCAST peg-in with unpinned fee 0", async () => {
  const store = new InMemoryGatewayStore();
  // A peg-in mid-mint: the dispatcher marks BROADCAST before the coordinator call, so the
  // fee is still the default 0 until CONFIRMED. Recon must not read that as an under-pin.
  await store.enqueue({ id: "bc", direction: "PEG_IN", remoteChain: "GRAM", recipient: "user", amountMilliViz: 45_000n, digest: "dbc" });
  await store.setStatus("bc", "BROADCAST");

  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 0n }],
    async () => 0n,
    store, cfg, "GRAM",
    1_000n, // sanity floor
  );
  assert.equal(await recon.check(), true, "in-flight fee-0 row must not trip the sanity floor");
  assert.equal(await store.isPaused(), false, "gateway must stay unpaused for an unpinned peg-in");
  assert.equal(await store.minPegInFeeMilliViz("GRAM"), null, "fee-0 rows are not counted as pinned");
});

test("minPegInFeeMilliViz returns null on empty store", async () => {
  const store = new InMemoryGatewayStore();
  assert.equal(await store.minPegInFeeMilliViz("GRAM"), null);
});

test("minPegInFeeMilliViz returns smallest pinned fee across multiple rows", async () => {
  const store = new InMemoryGatewayStore();
  for (const [i, fee] of [82_500n, 45_000n, 90_000n].entries()) {
    await store.enqueue({ id: `r${i}`, direction: "PEG_IN", remoteChain: "GRAM", recipient: "u", amountMilliViz: 1_000_000n, digest: `d${i}` });
    await store.setStatus(`r${i}`, "CONFIRMED");
    await store.setFee(`r${i}`, fee);
  }
  assert.equal(await store.minPegInFeeMilliViz("GRAM"), 45_000n);
});

test("minPegInFeeMilliViz ignores rows from a different chain", async () => {
  const store = new InMemoryGatewayStore();
  await store.enqueue({ id: "sol1", direction: "PEG_IN", remoteChain: "SOLANA", recipient: "u", amountMilliViz: 1_000_000n, digest: "s1" });
  await store.setStatus("sol1", "CONFIRMED");
  await store.setFee("sol1", 10_000n);
  // No GRAM rows → null for GRAM query
  assert.equal(await store.minPegInFeeMilliViz("GRAM"), null);
  assert.equal(await store.minPegInFeeMilliViz("SOLANA"), 10_000n);
});
