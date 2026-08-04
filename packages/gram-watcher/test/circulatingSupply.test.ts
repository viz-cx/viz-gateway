import { test } from "node:test";
import assert from "node:assert/strict";
import type { TonClient } from "@ton/ton";
import { GramHttpChain } from "../src/gramChain";

// circulatingSupplyMilliViz = totalSupply(minter) − held(gateway jetton wallet). The gateway-held
// balance is a NON-circulating reserve (peg-out wVIZ transferred in, pending burn), so it must be
// subtracted. The regression under test (2026-08-04): a TRANSIENT held-read failure must NOT fall
// back to raw totalSupply — with a large held reserve that over-counts circulating and trips a
// FALSE under-backing pause. It must re-throw so tonCall rotates endpoints, and if all fail, recon
// treats the supply as INDETERMINATE. A NON-transient (contract) error = uninitialized wallet =
// zero reserve = held 0 (raw totalSupply is then correct).

const MINTER = "EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ";
const GATEWAY_JW = "EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy";
const MULTISIG = "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0";

/**
 * A fake TonClient whose open() returns an object exposing BOTH getter methods the code calls —
 * getJettonData() (on the master-opened contract) and getBalance() (on the wallet-opened one).
 * The single mock serves both; the production code only calls the relevant one on each.
 */
function fakeClient(totalSupply: bigint, getBalance: () => Promise<bigint>): TonClient {
  return {
    open: (_c: unknown) => ({
      getJettonData: async () => ({ totalSupply }),
      getBalance,
    }),
  } as unknown as TonClient;
}

/** Build a chain and inject the fake client ring (mirrors the spike pattern: assign .clients). */
function chainWith(clients: TonClient[]): GramHttpChain {
  const chain = new GramHttpChain([`https://e${clients.length}/y`], "", MINTER, GATEWAY_JW, MULTISIG, 1);
  (chain as unknown as { clients: TonClient[] }).clients = clients;
  (chain as unknown as { idx: number }).idx = 0;
  return chain;
}

test("subtracts gateway-held reserve: circulating = totalSupply − held", async () => {
  const chain = chainWith([fakeClient(250_795_248n, async () => 3_960_000n)]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 246_835_248n);
});

test("circulating floors at 0 when held ≥ totalSupply (never negative)", async () => {
  const chain = chainWith([fakeClient(1_000n, async () => 5_000n)]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 0n);
});

test("TRANSIENT held-read failure PROPAGATES (single endpoint) — no over-count fallback", async () => {
  // The 2026-08-04 false-pause: held=3960 VIZ, a toncenter timeout on the held read. The OLD code
  // fell back to raw totalSupply (250795248), over-counting circulating by 3960 → phantom under-
  // backing. The fix re-throws so recon sees the supply as unavailable (indeterminate), not short.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => {
      throw new Error("timeout of 30000ms exceeded");
    }),
  ]);
  await assert.rejects(() => chain.circulatingSupplyMilliViz(), /timeout of 30000ms/);
});

test("TRANSIENT held-read failure ROTATES to a healthy endpoint and succeeds", async () => {
  // First endpoint's held read 5xx's; tonCall rotates; second endpoint reads held cleanly.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => {
      throw new Error("Request failed with status code 503");
    }),
    fakeClient(250_795_248n, async () => 3_960_000n),
  ]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 246_835_248n);
});

test("NON-transient (contract) held-read error ⇒ held=0 ⇒ raw totalSupply", async () => {
  // An uninitialized gateway wallet reverts the get-method — a genuine "zero reserve" state, not a
  // transport blip. Fall back to raw totalSupply (held=0 is correct); do NOT churn the ring.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => {
      throw new Error("Unable to execute get method");
    }),
  ]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 250_795_248n);
});
