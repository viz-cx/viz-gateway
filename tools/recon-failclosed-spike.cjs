// SPIKE: recon fails closed on node error, missing remotes, and sustained outages (VG-02).
// Exercises the real production Recon class offline with fake remotes + InMemoryGatewayStore:
//   1) zero remotes → constructor throws (fatal misconfiguration).
//   2) one remote throws → check() is indeterminate; circulating not reduced (no false OK);
//      after maxConsecutiveFailures consecutive failures → store.isPaused() true.
//   3) healthy check resets the failure counter (no pause after a transient blip + recovery).
//   4) genuine under-backing (circulating > locked) still pauses (regression guard).
//   5) an EXPECTED remote missing from config → constructor throws (finding D): a dropped
//      remote that still has circulating wVIZ must never silently leave the invariant.
//
// Run: node tools/recon-failclosed-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { InMemoryGatewayStore } = require("../packages/common/dist/store");
const { Recon, uncoveredActiveChains } = require("../packages/recon/dist/checker");

const MAX_FAIL = 3;
const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: MAX_FAIL };

function okRemote(name, supplyMilliViz) {
  return { name, supply: async () => BigInt(supplyMilliViz) };
}
function failingRemote(name) {
  return { name, supply: async () => { throw new Error("RPC down"); } };
}
function locked(milliViz) {
  return async () => BigInt(milliViz);
}

async function zeroRemotesThrows() {
  assert.throws(
    () => new Recon([], locked(1000), new InMemoryGatewayStore(), cfg),
    /no remote chain configured/,
    "zero remotes must throw at construction",
  );
  console.log("[recon-failclosed] zero-remotes fatal OK");
}

async function oneRemoteFailsIsIndeterminate() {
  const store = new InMemoryGatewayStore();
  // Two remotes: TON ok, SOLANA down. Locked = TON supply (fully backed if only TON).
  // If we were to use supply=0 for SOLANA, drift would look fine — but we must NOT do that.
  const recon = new Recon(
    [okRemote("GRAM", 500), failingRemote("SOLANA")],
    locked(500),
    store,
    cfg,
  );

  // Single failing check: indeterminate, not healthy, not paused yet.
  const r1 = await recon.check();
  assert.strictEqual(r1, null, "check with unavailable remote is indeterminate (null), not OK");
  assert.strictEqual(await store.isPaused(), false, "single failure does not pause immediately");
  console.log("[recon-failclosed] single remote-failure is indeterminate OK");

  // Drive to max consecutive failures via onCheckResult.
  await recon.onCheckResult(null); // failure 1
  assert.strictEqual(recon.consecutiveFailures, 1);
  assert.strictEqual(await store.isPaused(), false, "not paused after 1 failure");
  await recon.onCheckResult(null); // failure 2
  assert.strictEqual(recon.consecutiveFailures, 2);
  assert.strictEqual(await store.isPaused(), false, "not paused after 2 failures");
  await recon.onCheckResult(null); // failure 3 — reaches MAX_FAIL
  assert.strictEqual(recon.consecutiveFailures, 3);
  assert.strictEqual(await store.isPaused(), true, "paused after maxConsecutiveFailures");
  const reason = await store.pauseReason();
  assert.ok(reason && reason.includes("consecutive"), `pause reason mentions consecutive failures: "${reason}"`);
  console.log("[recon-failclosed] consecutive-failure escalation pauses OK");
}

async function recoveryResetsCounter() {
  const store = new InMemoryGatewayStore();
  const recon = new Recon([okRemote("GRAM", 500)], locked(500), store, cfg);

  // Two failures, then a successful check — counter resets, no pause.
  await recon.onCheckResult(null);
  await recon.onCheckResult(null);
  assert.strictEqual(recon.consecutiveFailures, 2, "two failures accumulated");

  // Healthy check
  const r = await recon.check();
  assert.strictEqual(r, true, "healthy check returns true");
  await recon.onCheckResult(r);
  assert.strictEqual(recon.consecutiveFailures, 0, "counter resets after a clean check");
  assert.strictEqual(await store.isPaused(), false, "no pause after blip + recovery");
  console.log("[recon-failclosed] recovery resets counter OK");
}

async function underBackingPauses() {
  const store = new InMemoryGatewayStore();
  // circulating (600) > locked (500) => under-backed
  const recon = new Recon([okRemote("GRAM", 600)], locked(500), store, cfg);
  const r = await recon.check();
  assert.strictEqual(r, false, "under-backed check returns false");
  assert.strictEqual(await store.isPaused(), true, "under-backing trips the pause");
  const reason = await store.pauseReason();
  assert.ok(reason && reason.includes("under-backing"), `pause reason mentions under-backing: "${reason}"`);
  // onCheckResult for a definitive false still resets the indeterminate counter.
  await recon.onCheckResult(r);
  assert.strictEqual(recon.consecutiveFailures, 0, "definitive result resets counter");
  console.log("[recon-failclosed] under-backing pause (regression guard) OK");
}

async function missingExpectedRemoteThrows() {
  // SOLANA has live supply but its config was dropped, so only TON is wired. Declaring
  // RECON_EXPECTED_REMOTES=[TON,SOLANA] makes recon refuse to start rather than under-count.
  assert.throws(
    () =>
      new Recon([okRemote("GRAM", 500)], locked(500), new InMemoryGatewayStore(), {
        ...cfg,
        expectedRemotes: ["GRAM", "SOLANA"],
      }),
    /expected remote\(s\) \[SOLANA\] missing/,
    "a declared-but-missing remote must throw at construction",
  );
  // When all declared remotes are present, construction succeeds.
  const ok = new Recon([okRemote("GRAM", 500), okRemote("SOLANA", 0)], locked(500), new InMemoryGatewayStore(), {
    ...cfg,
    expectedRemotes: ["GRAM", "SOLANA"],
  });
  assert.ok(ok, "all expected remotes present -> constructs");
  // Empty/absent expectedRemotes keeps the legacy behavior (only the >=1 guard applies).
  const legacy = new Recon([okRemote("GRAM", 500)], locked(500), new InMemoryGatewayStore(), cfg);
  assert.ok(legacy, "no expected-remotes list -> single remote still allowed");
  console.log("[recon-failclosed] missing expected remote fatal; present set OK; legacy unaffected OK");
}

// H6: recon must credit unswept fees RE-DERIVED from each row's gross, not the coordinator-pinned
// fee_milli_viz. A compromised/failed coordinator that understates the pinned fee (e.g. 0) must not
// be able to shrink expectedLocked and hide an under-backing.
async function coordinatorUnderstatedFeeCannotMask() {
  // base = max(floor 1000, 0.20% of gross). For gross 100_000 -> max(1000, 200) = 1000.
  const feePolicy = { floorMilliViz: 1000n, bps: 20, activationSurchargeMilliViz: 0n, mintGasFloorMilliViz: 0n };
  const store = new InMemoryGatewayStore();
  // A minted PEG_IN whose 1000 base fee was withheld as surplus but PINNED to 0 by the coordinator.
  await store.enqueue({ id: "gram-1:0", direction: "PEG_IN", remoteChain: "GRAM",
    recipient: "EQdest", sender: "alice", amountMilliViz: 100_000n, digest: "d", status: "CONFIRMED" });

  // Store-level: derived reads the real fee from gross; the pinned column is understated.
  assert.strictEqual(await store.unsweptFeesDerivedMilliViz(feePolicy, "GRAM"), 1000n, "derived fee comes from gross (1000)");
  assert.strictEqual(await store.unsweptFeesMilliViz("GRAM"), 0n, "coordinator understated the pinned fee to 0");

  // locked == circulating (1000) but does NOT cover the 1000 withheld fee -> under-backed by 1000.
  const remotes = () => [okRemote("GRAM", 1000)];
  // Pinned recon (no fee policy) is fooled: unswept=0 -> expectedLocked=1000 -> drift 0 -> "OK".
  const masked = await new Recon(remotes(), locked(1000), store, cfg, "GRAM").check();
  assert.strictEqual(masked, true, "pinned-fee recon is masked into reporting healthy");
  // Derived recon (production) sees unswept=1000 -> expectedLocked=2000 -> drift -1000 -> UNDER-BACKED.
  const caught = await new Recon(remotes(), locked(1000), store, cfg, "GRAM", feePolicy).check();
  assert.strictEqual(caught, false, "derived-fee recon catches the under-backing the coordinator tried to hide");
  console.log("[recon-failclosed] H6: coordinator-understated fee cannot mask under-backing (derived from gross) OK");
}

// M10: a NEGATIVE unswept fee (confirmed FEE_SWEEPs exceed the minted peg-in fees) is an
// over-sweep leaking backing. The store must NOT clamp it to 0 (which hid it), and recon must
// fail closed on it. The trap: a negative unswept makes expectedLocked SMALLER, so the drift
// looks POSITIVE (over-backed) and would report "OK" — the exact masking this guards against.
async function overSweepFailsClosed() {
  const store = new InMemoryGatewayStore();
  // Confirmed PEG_IN, pinned fee 5n.
  await store.enqueue({ id: "gram-1", direction: "PEG_IN", remoteChain: "GRAM",
    recipient: "EQdest", sender: "alice", amountMilliViz: 100_000n, digest: "d1", status: "CONFIRMED" });
  await store.setFee("gram-1", 5n);
  // A FEE_SWEEP that pulls MORE than the fee justifies (double sweep / mis-pin): 20n swept vs 5n owed.
  await store.enqueue({ id: "gram-1:fee", direction: "FEE_SWEEP", remoteChain: "GRAM",
    recipient: "fees.gate", sender: undefined, amountMilliViz: 20n, digest: "d2", status: "CONFIRMED" });

  // Store-level: the -15n is surfaced, NOT clamped to 0n.
  assert.strictEqual(await store.unsweptFeesMilliViz("GRAM"), -15n, "over-sweep surfaces as NEGATIVE unswept (not clamped)");

  // recon-level: locked==circulating==1000, so WITHOUT the guard expectedLocked=1000+(-15)=985,
  // drift=+15 => falsely "OK". The guard must trip first.
  const r = await new Recon([okRemote("GRAM", 1000)], locked(1000), store, cfg, "GRAM").check();
  assert.strictEqual(r, false, "over-sweep => fail closed (false), NOT masked as over-backed OK");
  assert.strictEqual(await store.isPaused(), true, "over-sweep trips the pause");
  const reason = await store.pauseReason();
  assert.ok(reason && reason.includes("over-swept"), `pause reason mentions over-sweep: "${reason}"`);
  console.log("[recon-failclosed] M10: negative unswept (over-sweep) fails closed, not masked OK");
}

// M9: recon must cover EVERY chain that has minted (or committed to minting) wVIZ, and that active
// set is derived from the OUTBOX (durable) — not from RECON_EXPECTED_REMOTES (env, defaults empty →
// fail-open when a live chain's config is dropped). store.activeRemoteChains() must classify only
// committed/minted PEG_INs as active; a chain that's active but uncovered must fail closed.
const PEG_IN = (id, chain, status) => ({
  id, direction: "PEG_IN", remoteChain: chain, recipient: "r", sender: "s",
  amountMilliViz: 100_000n, digest: "d-" + id, status,
});

async function activeChainsFromOutboxClassification() {
  // Each committed/minted status marks a chain active.
  for (const status of ["QUEUED", "SIGNING", "BROADCAST", "CONFIRMED"]) {
    const store = new InMemoryGatewayStore();
    await store.enqueue(PEG_IN("g-" + status, "GRAM", status));
    assert.deepStrictEqual(
      await store.activeRemoteChains(), ["GRAM"],
      `PEG_IN in ${status} marks its chain active`,
    );
  }
  // Non-committed / refunded / non-PEG_IN rows do NOT mark a chain active.
  const store = new InMemoryGatewayStore();
  await store.enqueue(PEG_IN("seen", "GRAM", "SEEN")); // detected, caps not yet passed
  await store.enqueue(PEG_IN("held", "SOLANA", "HELD")); // failed caps → refund, never mints
  await store.enqueue(PEG_IN("refd", "SOLANA", "REFUNDED"));
  await store.enqueue({ id: "sweep", direction: "FEE_SWEEP", remoteChain: "GRAM",
    recipient: "fees.gate", amountMilliViz: 5n, digest: "dsw", status: "CONFIRMED" });
  await store.enqueue({ id: "out", direction: "PEG_OUT", remoteChain: "SOLANA",
    recipient: "viz-acct", amountMilliViz: 10n, digest: "dout", status: "CONFIRMED" });
  assert.deepStrictEqual(
    await store.activeRemoteChains(), [],
    "SEEN/HELD/REFUNDED PEG_INs and FEE_SWEEP/PEG_OUT rows do not mark a chain active",
  );
  // Mixed: only the chains with a committed PEG_IN come back.
  const mixed = new InMemoryGatewayStore();
  await mixed.enqueue(PEG_IN("g1", "GRAM", "CONFIRMED"));
  await mixed.enqueue(PEG_IN("g2", "GRAM", "SEEN")); // same chain, doesn't double
  await mixed.enqueue(PEG_IN("s1", "SOLANA", "HELD")); // SOLANA only ever held → not active
  assert.deepStrictEqual(await mixed.activeRemoteChains(), ["GRAM"], "distinct active chains, GRAM only");
  console.log("[recon-failclosed] M9: activeRemoteChains classifies committed/minted PEG_INs only OK");
}

async function uncoveredActiveChainFailsClosed() {
  // SOLANA minted wVIZ (CONFIRMED peg-in) but its config was dropped, so recon covers only GRAM.
  const store = new InMemoryGatewayStore();
  await store.enqueue(PEG_IN("s1", "SOLANA", "CONFIRMED"));
  const covered = new Set(["GRAM"]);
  const uncovered = uncoveredActiveChains(await store.activeRemoteChains(), covered);
  assert.deepStrictEqual(uncovered, ["SOLANA"], "SOLANA is active but not covered by recon");
  // This is exactly the decision main() acts on → fail closed (pause).
  if (uncovered.length > 0) await store.pause(`active chain(s) [${uncovered.join(",")}] not covered by recon`);
  assert.strictEqual(await store.isPaused(), true, "uncovered active chain trips the pause (fail-closed)");

  // When recon DOES cover the active chain, nothing is uncovered → no pause.
  const store2 = new InMemoryGatewayStore();
  await store2.enqueue(PEG_IN("s1", "SOLANA", "CONFIRMED"));
  await store2.enqueue(PEG_IN("g1", "GRAM", "BROADCAST"));
  const uncovered2 = uncoveredActiveChains(await store2.activeRemoteChains(), new Set(["GRAM", "SOLANA"]));
  assert.deepStrictEqual(uncovered2, [], "covering every active chain → nothing uncovered");
  assert.strictEqual(await store2.isPaused(), false, "fully-covered recon does not pause");

  // A configured chain with NO circulating wVIZ yet (empty outbox) is fine — covered ⊇ active(∅).
  const store3 = new InMemoryGatewayStore();
  assert.deepStrictEqual(uncoveredActiveChains(await store3.activeRemoteChains(), new Set(["GRAM"])), [],
    "no active chains yet → nothing uncovered (a fresh gateway is not half-covered)");
  console.log("[recon-failclosed] M9: active-but-uncovered chain fails closed; covered set OK");
}

(async () => {
  await zeroRemotesThrows();
  await oneRemoteFailsIsIndeterminate();
  await recoveryResetsCounter();
  await underBackingPauses();
  await missingExpectedRemoteThrows();
  await coordinatorUnderstatedFeeCannotMask();
  await overSweepFailsClosed();
  await activeChainsFromOutboxClassification();
  await uncoveredActiveChainFailsClosed();
  console.log("recon-failclosed-spike: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
