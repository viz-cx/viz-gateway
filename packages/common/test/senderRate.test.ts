import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store";

test("tryReserveSenderRate allows up to N then blocks within the window", async () => {
  const store = createStore("memory:");
  const now = 10_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(await store.tryReserveSenderRate("alice", 3, 1000, now + i), true);
  }
  assert.equal(await store.tryReserveSenderRate("alice", 3, 1000, now + 3), false); // 4th blocked
  assert.equal(await store.tryReserveSenderRate("bob", 3, 1000, now + 3), true);    // per-sender
  // Window slides: entries older than now-window are pruned.
  assert.equal(await store.tryReserveSenderRate("alice", 3, 1000, now + 2000), true);
  await store.close();
});
