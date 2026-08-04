import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconSnapshotKey,
  serializeReconSnapshot,
  parseReconSnapshot,
  type ReconSnapshot,
} from "../src/recon-snapshot";

const SNAP: ReconSnapshot = {
  chain: "GRAM",
  lockedMilliViz: 43_547_500n,
  circulatingMilliViz: 43_500_000n,
  unsweptFeesMilliViz: 0n,
  driftMilliViz: 47_500n,
  status: "OK",
  checkedAt: 1_754_300_000_000,
};

test("snapshot key is namespaced per chain", () => {
  assert.equal(reconSnapshotKey("GRAM"), "recon:snapshot:GRAM");
  assert.notEqual(reconSnapshotKey("GRAM"), reconSnapshotKey("SOLANA"));
});

test("round-trips every field, bigints included", () => {
  assert.deepEqual(parseReconSnapshot(serializeReconSnapshot(SNAP)), SNAP);
});

test("round-trips a NEGATIVE drift (the under-backed case)", () => {
  const under: ReconSnapshot = {
    ...SNAP,
    lockedMilliViz: 40_000_000n,
    driftMilliViz: -3_500_000n,
    status: "UNDER_BACKED",
  };
  const back = parseReconSnapshot(serializeReconSnapshot(under));
  assert.equal(back?.driftMilliViz, -3_500_000n);
  assert.equal(back?.status, "UNDER_BACKED");
});

test("survives values beyond 2^53 without precision loss in the KV", () => {
  const huge: ReconSnapshot = { ...SNAP, lockedMilliViz: 9_007_199_254_740_993n };
  assert.equal(parseReconSnapshot(serializeReconSnapshot(huge))?.lockedMilliViz, 9_007_199_254_740_993n);
});

test("parse is fail-soft: absent / malformed input yields null, never throws", () => {
  assert.equal(parseReconSnapshot(null), null);
  assert.equal(parseReconSnapshot(undefined), null);
  assert.equal(parseReconSnapshot(""), null);
  assert.equal(parseReconSnapshot("not json"), null);
  assert.equal(parseReconSnapshot('{"chain":"GRAM"'), null, "truncated write must not throw");
  assert.equal(parseReconSnapshot("[]"), null);
  assert.equal(parseReconSnapshot("null"), null);
  assert.equal(parseReconSnapshot('"GRAM"'), null);
});

test("parse rejects a partial snapshot rather than defaulting fields to zero", () => {
  const full = JSON.parse(serializeReconSnapshot(SNAP)) as Record<string, unknown>;
  for (const field of Object.keys(full)) {
    const partial = { ...full };
    delete partial[field];
    assert.equal(parseReconSnapshot(JSON.stringify(partial)), null, `missing ${field} must not parse`);
  }
});

test("parse rejects non-numeric / non-integer figures and bad status", () => {
  const bad = (patch: Record<string, unknown>): string =>
    JSON.stringify({ ...JSON.parse(serializeReconSnapshot(SNAP)), ...patch });
  assert.equal(parseReconSnapshot(bad({ lockedMilliViz: 43547500 })), null, "number, not string");
  assert.equal(parseReconSnapshot(bad({ lockedMilliViz: "4.5" })), null);
  assert.equal(parseReconSnapshot(bad({ lockedMilliViz: "abc" })), null);
  assert.equal(parseReconSnapshot(bad({ status: "MAYBE" })), null);
  assert.equal(parseReconSnapshot(bad({ checkedAt: "1754300000000" })), null);
  assert.equal(parseReconSnapshot(bad({ chain: "" })), null);
});

test("parse ignores unknown fields so a future writer can extend the shape", () => {
  const extended = JSON.stringify({
    ...JSON.parse(serializeReconSnapshot(SNAP)),
    somethingNew: "later",
  });
  assert.deepEqual(parseReconSnapshot(extended), SNAP);
});
