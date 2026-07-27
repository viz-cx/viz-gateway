import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientRpcError, RPC_TIMEOUT_MS } from "../src/vizChain";

// isTransientRpcError is the decision boundary of the whole VIZ failover: TRUE rotates to the
// next node and retries; FALSE fails closed immediately. Getting it wrong in either direction is
// a live hazard — too broad masks a genuine "unknown transaction" behind four backoffs; too
// narrow re-creates the 2026-07-27 recon latch on a load-balancer blip. Lock the boundary here
// as fast unit cases (the spike only drives it end-to-end over HTTP with a couple of strings).

test("transient: load-balancer / transport failures rotate", () => {
  for (const msg of [
    "Request failed with status code 502",
    "Request failed with status code 503",
    "Request failed with status code 504",
    "Request failed with status code 429",
    "429 Too Many Requests",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "read ETIMEDOUT",
    "ECONNRESET",
    "connect ECONNREFUSED 1.2.3.4:443",
    "getaddrinfo EAI_AGAIN node.viz.cx",
    "socket hang up",
  ]) {
    assert.equal(isTransientRpcError(new Error(msg)), true, `should be transient: ${msg}`);
  }
});

test("transient: our own RPC_TIMEOUT_MS abort message rotates", () => {
  // callOnce rejects with exactly this shape when the transport wedges — it MUST be transient,
  // or a wedged node would fail closed instead of rotating.
  assert.equal(isTransientRpcError(new Error(`viz RPC timed out after ${RPC_TIMEOUT_MS}ms`)), true);
});

test("application errors fail closed (NOT transient)", () => {
  for (const msg of [
    "unknown transaction", // operation_history for an unconfirmed id — must stay fast
    "Assert Exception",
    "missing required active authority",
    "getDeposit(abc): node returned transaction_id",
    "no active authority found",
  ]) {
    assert.equal(isTransientRpcError(new Error(msg)), false, `must NOT be transient: ${msg}`);
  }
});

test("HTTP 500/501/505 are NOT transient for VIZ (only 502/503/504 + 429)", () => {
  // Deliberate: the VIZ pattern is 50[234], NOT 50x. A bare 500/501 from the node is treated as
  // an application-layer failure and fails closed rather than churning the ring.
  for (const code of ["500", "501", "505", "400", "404"]) {
    assert.equal(
      isTransientRpcError(new Error(`Request failed with status code ${code}`)),
      false,
      `HTTP ${code} must not be transient`,
    );
  }
});

test("digit run without a word boundary does not false-match a status code", () => {
  // \b(429|50[234])\b — a txid/hash fragment embedding these digits must not be read as a code.
  assert.equal(isTransientRpcError(new Error("txid ab1429cd not found")), false);
  assert.equal(isTransientRpcError(new Error("block 1502000 orphaned")), false);
});

test("accepts a bare string / non-Error and reads .message when present", () => {
  assert.equal(isTransientRpcError("502 Bad Gateway"), true);
  assert.equal(isTransientRpcError({ message: "ECONNRESET" }), true);
  assert.equal(isTransientRpcError("unknown transaction"), false);
  assert.equal(isTransientRpcError(undefined), false);
  assert.equal(isTransientRpcError(null), false);
});
