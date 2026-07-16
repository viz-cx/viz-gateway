import { test } from "node:test";
import assert from "node:assert/strict";
import { coldStartAnchorLt, paginateBurnsByLt } from "../src/gramChain";

// Regression: the gram-watcher cold-start cursor must NOT skip the wallet tip.
// The live incident (tx f9e87f2b…, 1970 wVIZ -> babin, 2026-07-16) was the
// gateway jetton wallet's first-ever transaction — an unprocessed peg-out deposit
// that was the tip when the watcher cold-started. Anchoring the cursor AT the tip's
// lt (the old behaviour) and then scanning `lt > cursor` dropped that deposit
// forever. coldStartAnchorLt anchors at tip-1 so the tip stays in range.

test("coldStartAnchorLt anchors just below a non-empty tip", () => {
  assert.equal(coldStartAnchorLt(90561578000007), 90561578000006);
  assert.equal(coldStartAnchorLt(1), 0);
});

test("coldStartAnchorLt on an empty wallet stays 0 (re-cold-start next tick)", () => {
  assert.equal(coldStartAnchorLt(0), 0);
});

// A minimal fake of @ton/core Transaction: paginateBurnsByLt only touches
// tx.lt, tx.now, and tx.hash() (the latter only when paging past a full page).
function fakeTx(lt: bigint, now: number) {
  return { lt, now, hash: () => Buffer.alloc(32, Number(lt % 251n)) };
}

// Drive paginateBurnsByLt exactly as finalizedBurnsPaginated does, over a wallet
// whose ONLY tx is a final deposit at `tipLt`, anchored from `fromLt`.
async function scanSingleDeposit(fromLt: number, tipLt: bigint) {
  const now = 1_000_000;
  return paginateBurnsByLt({
    fromLt: BigInt(fromLt),
    cutoff: now, // tx.now <= cutoff => final
    height: 1,
    limit: 20,
    maxScanPages: 50,
    fetchPage: async (anchor) => (anchor ? [] : [fakeTx(tipLt, now) as never]),
    toBurn: (tx) => ({
      chain: "GRAM",
      sourceId: (tx as ReturnType<typeof fakeTx>).hash().toString("hex"),
      height: 1,
      from: "sender",
      amountMilliViz: 1_970_000n,
      homeDestination: "babin",
    }),
  });
}

test("cold-start scan COLLECTS the first-ever peg-out (the tip) — regression", async () => {
  const tipLt = 90561578000007n;
  const cursor = coldStartAnchorLt(Number(tipLt)); // the fixed cold-start anchor
  const { burns, drained } = await scanSingleDeposit(cursor, tipLt);
  assert.equal(burns.length, 1, "the deposit that is the tip at cold-start must be scanned");
  assert.equal(burns[0]?.amountMilliViz, 1_970_000n);
  assert.equal(burns[0]?.homeDestination, "babin");
  assert.equal(drained, true);
});

test("the OLD behaviour (anchor AT the tip) drops it — documents the bug", async () => {
  const tipLt = 90561578000007n;
  const { burns } = await scanSingleDeposit(Number(tipLt), tipLt); // buggy: cursor === tip lt
  assert.equal(burns.length, 0, "anchoring AT the tip skips it — this was the bug");
});
