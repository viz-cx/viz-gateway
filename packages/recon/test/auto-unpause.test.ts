import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGatewayStore } from "@gateway/common";
import { AutoUnpause, Recon, RECON_STALLED_REASON_PREFIX } from "../src/checker";

const cfg = { driftToleranceMilliViz: 0n, maxConsecutiveFailures: 3 };

// 2026-08-21: sixth production pause. Every read guard behaved correctly — a sick toncenter
// node made 3 consecutive ticks indeterminate, the DESIGNED fail-closed "recon cannot verify
// backing" latch tripped — but clearing it still needed a human running RUNBOOK §10 five hours
// later. AutoUnpause self-repairs exactly that class: the pause that records a READ OUTAGE,
// never one that records an observed violation.

test("auto-unpause: stalled pause clears after exactly okTicksRequired consecutive OK ticks", async () => {
  const store = new InMemoryGatewayStore();
  let sick = true;
  const recon = new Recon(
    [{ name: "GRAM", supply: async () => { if (sick) throw new Error("exit_code: -13"); return 100n; } }],
    async () => 150n,
    store,
    cfg,
    "GRAM",
  );
  const auto = new AutoUnpause(store, 5);

  // Drive the real latch: 3 indeterminate ticks pause the gateway.
  for (let i = 0; i < 3; i++) {
    const r = await recon.check();
    await recon.onCheckResult(r);
    await auto.onTick(r === true);
  }
  assert.ok(await store.isPaused(), "stalled latch tripped");
  assert.match(String(await store.pauseReason()), new RegExp(`^${RECON_STALLED_REASON_PREFIX}`));

  // Node recovers: 4 OK ticks are not enough, the 5th clears the latch.
  sick = false;
  for (let i = 0; i < 4; i++) {
    const r = await recon.check();
    await recon.onCheckResult(r);
    assert.equal(await auto.onTick(r === true), false, `tick ${i + 1}: below threshold, stays paused`);
    assert.ok(await store.isPaused());
  }
  const r = await recon.check();
  await recon.onCheckResult(r);
  assert.equal(await auto.onTick(r === true), true, "5th consecutive OK tick unpauses");
  assert.equal(await store.isPaused(), false);
  assert.equal(await store.pauseReason(), null);
});

test("auto-unpause: a non-OK tick resets the streak", async () => {
  const store = new InMemoryGatewayStore();
  await store.pause(`${RECON_STALLED_REASON_PREFIX} (3 consecutive failures)`);
  const auto = new AutoUnpause(store, 3);

  await auto.onTick(true);
  await auto.onTick(true);
  await auto.onTick(false); // one more sick-node blip
  await auto.onTick(true);
  await auto.onTick(true);
  assert.ok(await store.isPaused(), "streak restarted — 2 OK ticks since the blip are not 3");
  assert.equal(await auto.onTick(true), true, "3rd consecutive OK tick after the blip unpauses");
});

test("auto-unpause: NEVER clears an under-backing pause, however long the OK streak", async () => {
  const store = new InMemoryGatewayStore();
  const recon = new Recon(
    [{ name: "GRAM", supply: async () => 200n }],
    async () => 100n, // genuine shortfall
    store,
    cfg,
    "GRAM",
  );
  await recon.check(); // latches the under-backing pause
  assert.match(String(await store.pauseReason()), /under-backing/);

  // Later ticks look healthy (e.g. backing restored out-of-band) — a human must still review.
  const auto = new AutoUnpause(store, 3);
  for (let i = 0; i < 20; i++) await auto.onTick(true);
  assert.ok(await store.isPaused(), "under-backing pause stays latched for a human");
});

test("auto-unpause: NEVER clears other pause classes (reserve, manual)", async () => {
  for (const reason of ["GRAM TON reserve low: 1 nano < 2", "manual: operator maintenance"]) {
    const store = new InMemoryGatewayStore();
    await store.pause(reason);
    const auto = new AutoUnpause(store, 1);
    await auto.onTick(true);
    assert.ok(await store.isPaused(), `"${reason}" stays latched`);
    assert.equal(await store.pauseReason(), reason, "reason untouched");
  }
});

test("auto-unpause: okTicksRequired <= 0 disables the mechanism", async () => {
  const store = new InMemoryGatewayStore();
  await store.pause(`${RECON_STALLED_REASON_PREFIX} (3 consecutive failures)`);
  const auto = new AutoUnpause(store, 0);
  for (let i = 0; i < 10; i++) assert.equal(await auto.onTick(true), false);
  assert.ok(await store.isPaused());
});

test("auto-unpause: no-op when not paused", async () => {
  const store = new InMemoryGatewayStore();
  const auto = new AutoUnpause(store, 1);
  assert.equal(await auto.onTick(true), false);
  assert.equal(await store.isPaused(), false);
});

test("auto-unpause: a stalled pause re-latched DURING the streak is still cleared only by a full fresh streak", async () => {
  // The streak counter lives in AutoUnpause while the latch lives in the store; a new stalled
  // pause always arrives with >= maxConsecutiveFailures non-OK ticks, which reset the streak,
  // so a fresh pause can never ride a stale streak. Pin that coupling.
  const store = new InMemoryGatewayStore();
  const auto = new AutoUnpause(store, 3);
  await auto.onTick(true);
  await auto.onTick(true); // streak = 2, nothing paused
  // 3 indeterminate ticks -> a new stalled pause (streak resets on each).
  for (let i = 0; i < 3; i++) await auto.onTick(false);
  await store.pause(`${RECON_STALLED_REASON_PREFIX} (3 consecutive failures)`);
  await auto.onTick(true);
  assert.ok(await store.isPaused(), "1 OK tick after the fresh pause is not a full streak");
});
