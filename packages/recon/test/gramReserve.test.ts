import { test } from "node:test";
import assert from "node:assert/strict";

import { belowTonFloor } from "../src/checker";

test("belowTonFloor trips only under the floor", () => {
  assert.equal(belowTonFloor(1_000_000_000n, 2_000_000_000), true);
  assert.equal(belowTonFloor(2_000_000_000n, 2_000_000_000), false);
  assert.equal(belowTonFloor(3_000_000_000n, 2_000_000_000), false);
});
