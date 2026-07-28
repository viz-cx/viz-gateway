import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { Recon } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// The 2026-07-28 false-pause: gatewayBalanceMilliViz coerced an empty getAccounts read to 0n, so
// recon saw locked=0 while gram.gate held 43.5k VIZ and PAUSED. The fix makes that read THROW; this
// test locks the resulting recon behaviour at the checker level (independent of the VIZ transport):
// a throwing backing read is INDETERMINATE (null) and must NOT pause.

test("recon: a throwing backing read is indeterminate (null), never a phantom under-backing pause", async () => {
  const store = new InMemoryGatewayStore();
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 43_444_908n }], // circulating exists...
    async () => {
      // ...but the backing read fails the way an empty getAccounts now does (post-fix: throws).
      throw new Error("gatewayBalanceMilliViz: backing account gram.gate not found (empty getAccounts read)");
    },
    store,
    cfg,
    "GRAM",
  );

  const r = await gram.check();
  assert.equal(r, null, "throwing backing read → indeterminate, not false");
  assert.equal(await store.isPaused(), false, "MUST NOT pause on an indeterminate backing read");
  assert.equal(await store.pauseReason(), null, "no pause reason recorded");
});

// The complement: the under-backing guard is NOT disabled by the fix. A backing read that genuinely
// RESOLVES to a shortfall (a real drained account, or circulating > locked) must still pause. This
// is the case the phantom 0n used to imitate — here it is real, so pausing is correct.
test("recon: a genuinely resolved shortfall still pauses (guard intact)", async () => {
  const store = new InMemoryGatewayStore();
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 43_444_908n }],
    async () => 0n, // real, resolved zero backing (not a throw) → genuine under-backing
    store,
    cfg,
    "GRAM",
  );

  const r = await gram.check();
  assert.equal(r, false, "resolved zero backing under circulating supply → under-backed");
  assert.ok(await store.isPaused(), "must pause on a genuine shortfall");
  assert.match(String(await store.pauseReason()), /under-backing/);
});

// A throwing read must not be swallowed as healthy either: check() returns null (indeterminate), and
// onCheckResult only pauses after maxConsecutiveFailures — so a sustained backing outage still trips
// the fail-closed pause, it just no longer does so on a single transient blip.
test("recon: sustained indeterminate backing reads eventually pause after maxConsecutiveFailures", async () => {
  const store = new InMemoryGatewayStore();
  const gram = new Recon(
    [{ name: "GRAM", supply: async () => 43_444_908n }],
    async () => {
      throw new Error("gatewayBalanceMilliViz: backing account gram.gate not found (empty getAccounts read)");
    },
    store,
    cfg,
    "GRAM",
  );

  for (let i = 0; i < cfg.maxConsecutiveFailures; i++) {
    assert.equal(await store.isPaused(), false, `not paused before threshold (iter ${i})`);
    await gram.onCheckResult(await gram.check());
  }
  assert.ok(await store.isPaused(), "sustained indeterminate reads must fail closed after threshold");
});
