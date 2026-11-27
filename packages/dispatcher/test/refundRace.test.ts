import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryResultFrom, planChildren, planTransition, type DeliveryResult } from "../src/policy";
import type { OutboxRecord } from "@gateway/common";

// Signers sign `<id>:refund` without checking the mint for the same deposit, so the dispatcher
// is the only thing keeping "minted" and "refunded" apart. These tests pin when a PEG_IN may
// reach REFUNDING: only on a coordinator VERDICT (200 body, reached after its actionExecuted
// check), and never on a row's first verdict.

const opts = { retryIntervalMs: 10_000, windowMs: 180_000 };
const T0 = 1_000_000;
const AGED = T0 + opts.windowMs; // exactly at the window edge
const row = (over: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "trx:0", direction: "PEG_IN", remoteChain: "GRAM", recipient: "EQ..", sender: "alice",
  amountMilliViz: 100_000n, feeMilliViz: 0n, digest: "d", status: "QUEUED",
  attempts: 0, lastError: null, txid: null, createdAt: T0, updatedAt: T0, nextAttemptAt: 0, parentId: null, blockNum: null,
  ...over,
});
const verdictFail: DeliveryResult = { broadcast: false, error: "approvals below threshold" };

// --- deliveryResultFrom: what counts as a verdict ---

test("200 broadcast:true is a success verdict with txid + fee", () => {
  const r = deliveryResultFrom(200, JSON.stringify({ broadcast: true, txid: "EQorder", feeMilliViz: "45000" }));
  assert.deepEqual(r, { broadcast: true, txid: "EQorder", feeMilliViz: 45_000n, error: undefined });
});

test("200 broadcast:false is a definitive failure verdict", () => {
  const r = deliveryResultFrom(200, JSON.stringify({ broadcast: false, error: "below minimum" }));
  assert.equal(r.broadcast, false);
  assert.equal(r.indeterminate, undefined);
  assert.equal(r.error, "below minimum");
});

for (const status of [401, 408, 413, 423, 500, 502, 503, 504]) {
  test(`HTTP ${status} is indeterminate even with a JSON error body`, () => {
    const r = deliveryResultFrom(status, JSON.stringify({ broadcast: false, error: "x" }));
    assert.equal(r.broadcast, false);
    assert.equal(r.indeterminate, true);
  });
}

test("a non-200 can never be read as a success, whatever the body says", () => {
  for (const status of [201, 202, 204, 500, 504]) {
    assert.equal(deliveryResultFrom(status, JSON.stringify({ broadcast: true, txid: "x" })).broadcast, false);
  }
});

test("garbled / truncated / verdict-less 200 bodies are indeterminate", () => {
  for (const body of ["", "<html>504</html>", '{"broadcast":tr', "null", "[]", "{}", '"ok"', '{"broadcast":"false"}', '{"broadcast":0}']) {
    const r = deliveryResultFrom(200, body);
    assert.equal(r.indeterminate, true, `body ${JSON.stringify(body)}`);
    assert.equal(r.broadcast, false);
  }
});

test("an unparseable fee does not turn a landed mint into a failure", () => {
  const r = deliveryResultFrom(200, JSON.stringify({ broadcast: true, txid: "t", feeMilliViz: "12.5" }));
  assert.equal(r.broadcast, true);
  assert.equal(r.feeMilliViz, undefined);
  assert.equal(planTransition(row({ attempts: 3 }), r, AGED, opts).status, "CONFIRMED");
});

test("non-string txid/error fields are dropped, not propagated", () => {
  const r = deliveryResultFrom(200, JSON.stringify({ broadcast: false, txid: { a: 1 }, error: 7 }));
  assert.equal(r.txid, undefined);
  assert.equal(r.error, undefined);
});

// --- planTransition: when REFUNDING is reachable ---

test("refund matrix: needs PEG_IN + aged + verdict + a prior attempt", () => {
  for (const direction of ["PEG_IN", "PEG_OUT", "FEE_SWEEP", "REFUND", "GRAM_RETURN"] as const) {
    for (const aged of [false, true]) {
      for (const indeterminate of [false, true]) {
        for (const attempts of [0, 1, 7]) {
          const t = planTransition(
            row({ direction, attempts }),
            { broadcast: false, error: "e", indeterminate },
            aged ? AGED : AGED - 1,
            opts,
          );
          const expectRefund = direction === "PEG_IN" && aged && !indeterminate && attempts > 0;
          assert.equal(t.status, expectRefund ? "REFUNDING" : "QUEUED", JSON.stringify({ direction, aged, indeterminate, attempts }));
          assert.equal(t.patch.attempts, attempts + 1);
        }
      }
    }
  }
});

test("success always wins: CONFIRMED regardless of age, attempts or a stray indeterminate flag", () => {
  for (const attempts of [0, 5]) {
    const t = planTransition(row({ attempts }), { broadcast: true, txid: "t", indeterminate: true }, AGED * 2, opts);
    assert.equal(t.status, "CONFIRMED");
  }
});

test("an endless run of indeterminate results never refunds", () => {
  let rec = row();
  for (let i = 0; i < 500; i++) {
    const now = T0 + i * opts.retryIntervalMs;
    const t = planTransition(rec, deliveryResultFrom(504, ""), now, opts);
    assert.equal(t.status, "QUEUED");
    rec = { ...rec, attempts: t.patch.attempts ?? rec.attempts };
  }
});

// --- end-to-end sequences through both functions ---

/** Drive one row through a scripted series of coordinator responses; return every status. */
function drive(start: OutboxRecord, steps: Array<{ at: number; status: number; body?: unknown }>): string[] {
  let rec = start;
  const seen: string[] = [];
  for (const s of steps) {
    const res = deliveryResultFrom(s.status, s.body === undefined ? "" : JSON.stringify(s.body));
    const t = planTransition(rec, res, T0 + s.at, opts);
    seen.push(t.status);
    if (t.status !== "QUEUED") break;
    rec = { ...rec, attempts: t.patch.attempts ?? rec.attempts };
  }
  return seen;
}

test("proxy cuts a slow mint past the window, the re-drive finds it landed: CONFIRMED, never refunded", () => {
  const seen = drive(row(), [
    { at: 200_000, status: 504 }, // backlog: first delivery already past the window
    { at: 210_000, status: 200, body: { broadcast: true, txid: "EQorder", feeMilliViz: "0" } },
  ]);
  assert.deepEqual(seen, ["QUEUED", "CONFIRMED"]);
});

test("post-unpause backlog: an aged row's first verdict retries, only the second refunds", () => {
  const seen = drive(row(), [
    { at: 3_600_000, status: 200, body: { broadcast: false, error: "approvals below threshold" } },
    { at: 3_610_000, status: 200, body: { broadcast: false, error: "approvals below threshold" } },
  ]);
  assert.deepEqual(seen, ["QUEUED", "REFUNDING"]);
});

test("coordinator 500 (could not check on-chain state) after a lost response never refunds", () => {
  const seen = drive(row(), [
    { at: 60_000, status: 504 }, // mint may have landed; response lost
    { at: 190_000, status: 500, body: { error: "Error: toncenter 503" } },
    { at: 200_000, status: 500, body: { error: "Error: toncenter 503" } },
    { at: 210_000, status: 200, body: { broadcast: true, txid: "EQorder" } },
  ]);
  assert.deepEqual(seen, ["QUEUED", "QUEUED", "QUEUED", "CONFIRMED"]);
});

test("a below-minimum deposit still refunds once the window passes (verdict path stays live)", () => {
  const body = { broadcast: false, error: "Error: PEG_IN trx:0 below minimum (refund)" };
  const seen = drive(row(), [
    { at: 5_000, status: 200, body },
    { at: 100_000, status: 200, body },
    { at: 185_000, status: 200, body },
  ]);
  assert.deepEqual(seen, ["QUEUED", "QUEUED", "REFUNDING"]);
});

test("paused coordinator past the window waits instead of refunding", () => {
  assert.deepEqual(drive(row({ attempts: 4 }), [{ at: 500_000, status: 423, body: { error: "paused" } }]), ["QUEUED"]);
});

test("orphan-recovered row (attempts bumped, no verdict yet) still needs a verdict to refund", () => {
  const recovered = row({ attempts: 1 });
  assert.equal(planTransition(recovered, deliveryResultFrom(502, ""), AGED, opts).status, "QUEUED");
  assert.equal(planTransition(recovered, verdictFail, AGED, opts).status, "REFUNDING");
});

// --- the refund child only exists behind REFUNDING ---

test("no REFUND child is planned for any status but REFUNDING", () => {
  const ctx = { feesGateAccount: "fees.gate", sweepAmountMilliViz: 0n, refundFeeMilliViz: 5_000n };
  for (const status of ["SEEN", "QUEUED", "BROADCAST", "CONFIRMED", "HELD", "REFUNDED"] as const) {
    assert.deepEqual(planChildren(row(), status, ctx), [], status);
  }
  assert.equal(planChildren(row(), "REFUNDING", ctx)[0]?.id, "trx:0:refund");
});

test("a retried (QUEUED) outcome spawns neither a refund nor a fee sweep", () => {
  const t = planTransition(row({ attempts: 2 }), deliveryResultFrom(504, ""), AGED, opts);
  const kids = planChildren(row(), t.status, { feesGateAccount: "fees.gate", sweepAmountMilliViz: 1_000n, refundFeeMilliViz: 5_000n });
  assert.deepEqual(kids, []);
});

// KNOWN GAP (characterization, not a goal): a definitive "below threshold" verdict cannot see a
// signer approval that lands on-chain AFTER the round ended. Only the signer-side refund guard
// closes this — see plans/2026-11-27-signer-refund-guard.md. If this starts failing because the
// dispatcher learned to wait, delete it.
test("KNOWN GAP: two definitive failures past the window refund even if an approval lands later", () => {
  assert.equal(planTransition(row({ attempts: 1 }), verdictFail, AGED, opts).status, "REFUNDING");
});
