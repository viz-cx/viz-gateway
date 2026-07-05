import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "../src/store";

// Two confirmed PEG_INs (5n SOLANA, 7n GRAM) and one confirmed SOLANA FEE_SWEEP of 5n.
// After sweep: SOLANA unswept = 0n, GRAM unswept = 7n, global = 7n.

async function buildStore(): Promise<InMemoryGatewayStore> {
  const store = new InMemoryGatewayStore();

  // SOLANA PEG_IN: fee 5n
  await store.enqueue({
    id: "sol-pegin-1",
    direction: "PEG_IN",
    remoteChain: "SOLANA",
    recipient: "solana-user",
    sender: undefined,
    amountMilliViz: 100n,
    digest: "d1",
  });
  await store.setStatus("sol-pegin-1", "CONFIRMED");
  await store.setFee("sol-pegin-1", 5n);

  // GRAM PEG_IN: fee 7n
  await store.enqueue({
    id: "gram-pegin-1",
    direction: "PEG_IN",
    remoteChain: "GRAM",
    recipient: "gram-user",
    sender: undefined,
    amountMilliViz: 200n,
    digest: "d2",
  });
  await store.setStatus("gram-pegin-1", "CONFIRMED");
  await store.setFee("gram-pegin-1", 7n);

  // SOLANA FEE_SWEEP: amount 5n (sweeps the SOLANA fee)
  await store.enqueue({
    id: "sol-pegin-1:fee",
    direction: "FEE_SWEEP",
    remoteChain: "SOLANA",
    recipient: "fees.gate",
    sender: undefined,
    amountMilliViz: 5n,
    digest: "d3",
  });
  await store.setStatus("sol-pegin-1:fee", "CONFIRMED");

  return store;
}

test("unsweptFeesMilliViz('SOLANA') = 0n after sweep", async () => {
  const store = await buildStore();
  assert.equal(await store.unsweptFeesMilliViz("SOLANA"), 0n);
});

test("unsweptFeesMilliViz('GRAM') = 7n (no GRAM sweep yet)", async () => {
  const store = await buildStore();
  assert.equal(await store.unsweptFeesMilliViz("GRAM"), 7n);
});

test("unsweptFeesMilliViz() global = 7n (GRAM unswept)", async () => {
  const store = await buildStore();
  assert.equal(await store.unsweptFeesMilliViz(), 7n);
});
