// SPIKE: the VIZ read path retries TRANSIENT node failures (HTTP 502/503/504, socket
// resets, timeouts) with bounded backoff, so a single blip inside a MAX_BLOCKS_PER_SCAN
// sweep no longer rejects the whole window and resets the watcher's cursor. Observed live:
// node.viz.cx returned sporadic 502s, every scan window that hit one restarted from the
// same cursor, and under a steady 502 rate the watcher never swept past an on-chain lock
// inside the peg-in timeout — the deposit was confirmed but the mint never fired.
//
// Exercises the REAL compiled VizJsChain offline against a local JSON-RPC server:
//   1) isTransientRpcError: 5xx / socket / timeout => retry; app errors ("unknown
//      transaction") => do NOT retry (getDeposit/confirmReleaseByTxId must fail fast).
//   2) 502 twice then 200 -> lastIrreversibleBlock() RESOLVES, and the server saw
//      exactly 3 requests (two retries) — a transient node recovers instead of aborting.
//   3) a non-transient JSON-RPC error -> rejects after exactly ONE request (no wasted
//      backoff on a legit not-found).
//
// Run: node tools/viz-rpc-retry-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const {
  VizJsChain,
  isTransientRpcError,
  RPC_MAX_ATTEMPTS,
} = require("../packages/viz-watcher/dist/vizChain");
const { buildGatewayAccounts, loadConfig } = require("../packages/common/dist");

// Minimal gateway-accounts registry so the VizJsChain constructor is satisfied. The read
// paths under test (lastIrreversibleBlock) don't consult it, so a single mapping is enough.
function accounts() {
  const KEYS = ["VIZ_GATEWAY_ACCOUNT_GRAM", "VIZ_GATEWAY_ACCOUNT_SOLANA", "FEDERATION_N", "FEDERATION_THRESHOLD"];
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.VIZ_GATEWAY_ACCOUNT_GRAM = "gw";
  process.env.VIZ_GATEWAY_ACCOUNT_SOLANA = "gw.sol";
  process.env.FEDERATION_N = "1";
  process.env.FEDERATION_THRESHOLD = "1";
  try {
    return buildGatewayAccounts(loadConfig());
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// A JSON-RPC server whose response is decided per-request by `plan(n)` (1-based request #).
// viz-js-lib increments the request id per call and rejects a mismatched response id, so the
// canned body echoes the id the client actually sent. Returns { url, requests() } so a test
// can assert how many attempts actually hit the wire.
function rpcServer(plan) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n += 1;
      let reqId = 1;
      try { reqId = JSON.parse(raw).id ?? 1; } catch { /* non-JSON body */ }
      const { status, body } = plan(n, reqId);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests: () => n, close: () => server.close() }),
    );
  });
}

const okGdgpBody = (id) => ({ jsonrpc: "2.0", id, result: { last_irreversible_block_num: 424242 } });

function classification() {
  for (const t of ["HTTP 502: Bad Gateway", "HTTP 503: Service Unavailable", "HTTP 429: Too Many Requests", "gateway time-out", "read ETIMEDOUT", "ECONNRESET", "socket hang up", "viz RPC timed out after 20000ms"]) {
    assert.ok(isTransientRpcError(new Error(t)), `should retry transient: ${t}`);
  }
  for (const t of ["unknown transaction", "Assert Exception (10)", "HTTP 400: Bad Request", "invalid signature"]) {
    assert.ok(!isTransientRpcError(new Error(t)), `must NOT retry: ${t}`);
  }
  assert.strictEqual(RPC_MAX_ATTEMPTS, 4, "4 attempts (1 + 3 retries)");
  console.log("[viz-rpc-retry] isTransientRpcError classification OK");
}

async function retriesThenSucceeds() {
  // 502, 502, then a valid result: the third attempt wins.
  const srv = await rpcServer((n, id) => (n < 3 ? { status: 502, body: "Bad Gateway" } : { status: 200, body: okGdgpBody(id) }));
  const chain = new VizJsChain(srv.url, accounts());
  const start = Date.now();
  const lib = await chain.lastIrreversibleBlock();
  const elapsed = Date.now() - start;
  srv.close();
  assert.strictEqual(lib, 424242, "should return the LIB from the eventual 200");
  assert.strictEqual(srv.requests(), 3, `expected 3 requests (2 retries), saw ${srv.requests()}`);
  // Backoff after attempts 1 and 2 is 500 + 1000 = 1500ms; generous ceiling to stay non-flaky.
  assert.ok(elapsed >= 1400 && elapsed < 8000, `backoff should be ~1.5s, took ${elapsed}ms`);
  console.log(`[viz-rpc-retry] 502x2 then 200 recovers in ${elapsed}ms after ${srv.requests()} requests OK`);
}

async function nonTransientFailsFast() {
  // A JSON-RPC application error (unknown trx) is NOT transient: reject after ONE request.
  const srv = await rpcServer((_n, id) => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code: 10, message: "unknown transaction" } } }));
  const chain = new VizJsChain(srv.url, accounts());
  await assert.rejects(() => chain.lastIrreversibleBlock(), "a non-transient error must propagate");
  assert.strictEqual(srv.requests(), 1, `non-transient error must NOT retry; saw ${srv.requests()} requests`);
  srv.close();
  console.log("[viz-rpc-retry] non-transient error fails fast (1 request, no backoff) OK");
}

async function exhaustsThenThrows() {
  // Always 502: after RPC_MAX_ATTEMPTS the transient finally propagates (window aborts,
  // watcher retries on the next tick) rather than looping forever.
  const srv = await rpcServer(() => ({ status: 502, body: "Bad Gateway" }));
  const chain = new VizJsChain(srv.url, accounts());
  await assert.rejects(() => chain.lastIrreversibleBlock(), /502/, "persistent 502 must eventually throw");
  assert.strictEqual(srv.requests(), RPC_MAX_ATTEMPTS, `should try exactly ${RPC_MAX_ATTEMPTS} times, saw ${srv.requests()}`);
  srv.close();
  console.log(`[viz-rpc-retry] persistent 502 throws after ${RPC_MAX_ATTEMPTS} attempts OK`);
}

(async () => {
  classification();
  await retriesThenSucceeds();
  await nonTransientFailsFast();
  await exhaustsThenThrows();
  console.log("[viz-rpc-retry] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
