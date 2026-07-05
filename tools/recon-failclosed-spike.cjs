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
const { Recon } = require("../packages/recon/dist/checker");

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
    [okRemote("TON", 500), failingRemote("SOLANA")],
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
  const recon = new Recon([okRemote("TON", 500)], locked(500), store, cfg);

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
  const recon = new Recon([okRemote("TON", 600)], locked(500), store, cfg);
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
      new Recon([okRemote("TON", 500)], locked(500), new InMemoryGatewayStore(), {
        ...cfg,
        expectedRemotes: ["TON", "SOLANA"],
      }),
    /expected remote\(s\) \[SOLANA\] missing/,
    "a declared-but-missing remote must throw at construction",
  );
  // When all declared remotes are present, construction succeeds.
  const ok = new Recon([okRemote("TON", 500), okRemote("SOLANA", 0)], locked(500), new InMemoryGatewayStore(), {
    ...cfg,
    expectedRemotes: ["TON", "SOLANA"],
  });
  assert.ok(ok, "all expected remotes present -> constructs");
  // Empty/absent expectedRemotes keeps the legacy behavior (only the >=1 guard applies).
  const legacy = new Recon([okRemote("TON", 500)], locked(500), new InMemoryGatewayStore(), cfg);
  assert.ok(legacy, "no expected-remotes list -> single remote still allowed");
  console.log("[recon-failclosed] missing expected remote fatal; present set OK; legacy unaffected OK");
}

(async () => {
  await zeroRemotesThrows();
  await oneRemoteFailsIsIndeterminate();
  await recoveryResetsCounter();
  await underBackingPauses();
  await missingExpectedRemoteThrows();
  console.log("recon-failclosed-spike: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
