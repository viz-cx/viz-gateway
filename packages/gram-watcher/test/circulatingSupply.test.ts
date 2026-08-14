import { test } from "node:test";
import assert from "node:assert/strict";
import type { TonClient } from "@ton/ton";
import { GramHttpChain } from "../src/gramChain";

// circulatingSupplyMilliViz = totalSupply(minter) − held(gateway jetton wallet). The gateway-held
// balance is a NON-circulating reserve (peg-out wVIZ transferred in, pending burn), so it must be
// subtracted. The regression under test (2026-08-04): a TRANSIENT held-read failure must NOT fall
// back to raw totalSupply — with a large held reserve that over-counts circulating and trips a
// FALSE under-backing pause. It must re-throw so tonCall rotates endpoints, and if all fail, recon
// treats the supply as INDETERMINATE. A NON-transient (contract) error falls back to held=0 ONLY
// when getContractState positively shows the wallet not active (2026-08-12: a sick node's
// "exit_code: -13" on the deployed wallet must NOT be taken as proof of zero reserve).

const MINTER = "EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ";
const GATEWAY_JW = "EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy";
const MULTISIG = "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0";

/**
 * A fake TonClient whose open() returns an object exposing BOTH getter methods the code calls —
 * getJettonData() (on the master-opened contract) and getBalance() (on the wallet-opened one).
 * The single mock serves both; the production code only calls the relevant one on each.
 */
function fakeClient(totalSupply: bigint, getBalance: () => Promise<bigint>, state = "active"): TonClient {
  return {
    open: (_c: unknown) => ({
      getJettonData: async () => ({ totalSupply }),
      getBalance,
    }),
    getContractState: async () => ({ state }),
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

test("NON-transient held-read error + wallet NOT active ⇒ held=0 ⇒ raw totalSupply", async () => {
  // An uninitialized gateway wallet reverts the get-method — a genuine "zero reserve" state, not a
  // transport blip. The state read POSITIVELY confirms it; only then is raw totalSupply correct.
  const chain = chainWith([
    fakeClient(
      250_795_248n,
      async () => {
        throw new Error("Unable to execute get method");
      },
      "uninitialized",
    ),
  ]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 250_795_248n);
});

test("NON-transient held-read error + wallet ACTIVE ⇒ PROPAGATES (sick node, no held=0 guess)", async () => {
  // The 2026-08-12 false-pause: a node answered an exit_code for the DEPLOYED gateway wallet.
  // The old code took any non-transient error as proof of an uninitialized wallet and fell back to
  // raw totalSupply, over-counting circulating by the 3960 VIZ reserve. With the wallet provably
  // active, the error must propagate so recon goes INDETERMINATE instead of pausing. (Uses -14,
  // not -13: -13 is now classified transient and would rotate before reaching the state check.)
  const chain = chainWith([
    fakeClient(250_795_248n, async () => {
      throw new Error("Unable to execute get method. Got exit_code: -14");
    }),
  ]);
  await assert.rejects(() => chain.circulatingSupplyMilliViz(), /exit_code: -14/);
});

test("exit_code -13 held read ROTATES to a healthy endpoint (2026-08-13 recon-stalled pause)", async () => {
  // The sick node returned "-13" intermittently for the deployed minter + gateway wallet while a
  // verified Orbs endpoint sat unused in the ring. -13 is the node's get-method gas limit, not a
  // contract answer, so it must rotate rather than fail closed — 3 such ticks latched the
  // "recon cannot verify backing (3 consecutive failures)" pause.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => {
      throw new Error("Unable to execute get method. Got exit_code: -13");
    }),
    fakeClient(250_795_248n, async () => 3_960_000n),
  ]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 246_835_248n);
});

test("held=0 contradicted by another endpoint ⇒ PROPAGATES (2026-08-13 false −3912500 pause)", async () => {
  // The dangerous one: no exception, no warning — a sick node simply answers 0 for the funded
  // gateway wallet. That zero is DEFINITIVE, so it resets recon's failure counter and pauses on a
  // phantom shortfall of the whole 3960 VIZ reserve. A second opinion of 3960000 exposes it.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => 0n),
    fakeClient(250_795_248n, async () => 3_960_000n),
  ]);
  await assert.rejects(() => chain.circulatingSupplyMilliViz(), /held-balance disagreement/);
});

test("held=0 confirmed by every endpoint ⇒ accepted (an emptied wallet really holds 0)", async () => {
  // The guard must not turn a legitimately empty reserve into a permanent INDETERMINATE: with the
  // ring in agreement, circulating is raw totalSupply and recon keeps reporting definitively.
  const chain = chainWith([
    fakeClient(250_795_248n, async () => 0n),
    fakeClient(250_795_248n, async () => 0n),
  ]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 250_795_248n);
});

test("held=0 with a single endpoint ⇒ accepted (nobody to ask; unchanged behaviour)", async () => {
  const chain = chainWith([fakeClient(250_795_248n, async () => 0n)]);
  assert.equal(await chain.circulatingSupplyMilliViz(), 250_795_248n);
});
