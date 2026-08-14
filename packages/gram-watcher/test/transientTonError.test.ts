import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientTonError, buildTonClients } from "../src/gramChain";

// isTransientTonError is the GRAM/TON failover boundary: TRUE rotates to the next endpoint; FALSE
// fails closed. The spike drives a couple of strings end-to-end over HTTP; this locks the full
// boundary — especially the toncenter/axios timeout shapes and the "contract result is NOT
// transient" rule that keeps a real executed/not-found read fast and fail-closed.

test("transient: toncenter/axios transport failures rotate", () => {
  for (const msg of [
    "Request failed with status code 500",
    "Request failed with status code 502",
    "Request failed with status code 503",
    "Request failed with status code 504",
    "Request failed with status code 429",
    "429 too many requests",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "timeout of 30000ms exceeded", // axios timeout shape
    "read ETIMEDOUT",
    "ECONNRESET",
    "connect ECONNREFUSED 1.2.3.4:443",
    "getaddrinfo EAI_AGAIN toncenter.com",
    "getaddrinfo ENOTFOUND toncenter.com",
    "socket hang up",
    "Network Error",
  ]) {
    assert.equal(isTransientTonError(new Error(msg)), true, `should be transient: ${msg}`);
  }
});

test("contract-level results fail closed (NOT transient)", () => {
  // An exit_code / "unable to execute get method" is a genuine chain state (order not deployed,
  // get-method reverted) — rotating would only churn the ring and mask the real answer.
  for (const msg of [
    "Received error: unable to execute get method",
    'Received an error: {"ok":false,"error":"exit_code: -14"}',
    'Received an error: {"ok":false,"error":"exit_code: 13"}', // positive 13 is a contract answer
    "Malformed response: invalid address",
    "Invalid address",
    "Unable to parse",
  ]) {
    assert.equal(isTransientTonError(new Error(msg)), false, `must NOT be transient: ${msg}`);
  }
});

test("exit_code -13 (TVM out-of-gas) IS transient — the node's gas limit, not a contract answer", () => {
  // 2026-08-13: a sick toncenter node returned -13 intermittently for the deployed minter and
  // gateway wallet. Classified fail-closed, tonCall never rotated onto the healthy Orbs endpoint
  // already in the ring, and 3 such ticks latched the "cannot verify backing" pause.
  for (const msg of [
    'Received an error: {"ok":false,"error":"exit_code: -13"}',
    "Unable to execute get method. Got exit_code: -13",
    "exit_code:-13",
  ]) {
    assert.equal(isTransientTonError(new Error(msg)), true, `should be transient: ${msg}`);
  }
});

test("HTTP 501 is NOT transient for TON (pattern is 50[0234])", () => {
  // GRAM treats 500/502/503/504 as transient but deliberately not 501/505.
  for (const code of ["501", "505", "400", "404"]) {
    assert.equal(
      isTransientTonError(new Error(`Request failed with status code ${code}`)),
      false,
      `HTTP ${code} must not be transient`,
    );
  }
});

test("accepts a bare string / non-Error and reads .message when present", () => {
  assert.equal(isTransientTonError("timeout of 5000ms exceeded"), true);
  assert.equal(isTransientTonError({ message: "ECONNRESET" }), true);
  assert.equal(isTransientTonError("unable to execute get method"), false);
  assert.equal(isTransientTonError(undefined), false);
});

test("buildTonClients: one client per endpoint, whitespace trimmed, empties dropped", () => {
  const clients = buildTonClients(
    ["  https://toncenter.com/api/v2/jsonRPC ", "", "   ", "https://orbs/y"],
    "",
    10_000,
  );
  assert.equal(clients.length, 2, "blank/whitespace endpoints are dropped");
});

test("buildTonClients: an all-empty list is a fail-closed configuration error", () => {
  assert.throws(() => buildTonClients(["", "   "], "", 10_000), /at least one GRAM endpoint/);
});
