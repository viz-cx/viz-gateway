// SPIKE: the GRAM (TON) read path FAILS OVER across a toncenter-v2 endpoint list on TRANSIENT
// errors. GRAM_ENDPOINT may carry several endpoints (keyed toncenter + an Orbs fallback); on a
// 5xx/timeout/429 GramHttpChain rotates to the next TonClient and retries. This is the exact
// class of failure that latched recon on 2026-07-27 (toncenter ETIMEDOUT on the backing read).
//
// Exercises the REAL compiled GramHttpChain / buildTonClients / isTransientTonError against
// local toncenter-shaped JSON-RPC servers (doCall POSTs {method:'getMasterchainInfo'} and expects
// {ok:true,result:{last:{seqno,...}}}; a non-200 makes axios reject with "...status code 5xx"):
//   1) classification: 5xx/timeout/429/socket => transient; ok:false app error / bad addr => not.
//   2) endpoint0 5xx, endpoint1 healthy -> rotate -> finalizedHeight() resolves; idx sticky.
//   3) an application error (HTTP 200 ok:false) throws WITHOUT rotating (fail-closed).
//   4) all endpoints down -> one pass through the ring (attempts == endpoint count) then throw.
//   5) single endpoint == today: exactly one request, no retry/rotation.
//   6) buildTonClients applies GRAM_API_KEY ONLY to toncenter-host endpoints (Orbs gets none).
//
// Run: node tools/gram-rpc-failover-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const {
  GramHttpChain,
  buildTonClients,
  isTransientTonError,
} = require("../packages/gram-watcher/dist/gramChain");

// Valid raw address (workchain 0, zero hash) — GramHttpChain's ctor parses the minter; the
// finalizedHeight() read under test does not consult it.
const ZERO_ADDR = "0:" + "0".repeat(64);

const blockIdExt = (seqno) => ({
  "@type": "ton.blockIdExt",
  workchain: -1,
  shard: "-9223372036854775808",
  seqno,
  root_hash: "cm9vdA==",
  file_hash: "ZmlsZQ==",
});
const masterchainResult = (seqno) => ({ state_root_hash: "c3Jo", last: blockIdExt(seqno), init: blockIdExt(0) });

// toncenter-shaped server; `plan(n)` decides each response. Records X-API-Key seen.
function tonServer(plan) {
  let n = 0;
  let lastApiKey = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n += 1;
      lastApiKey = req.headers["x-api-key"] ?? null;
      const r = plan(n);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests: () => n,
        lastApiKey: () => lastApiKey,
        close: () => server.close(),
      }),
    );
  });
}

const ok = (seqno) => () => ({ status: 200, body: { ok: true, result: masterchainResult(seqno) } });
const http500 = () => ({ status: 500, body: { ok: false, error: "backend down" } });
const appError = () => ({ status: 200, body: { ok: false, error: "unable to execute get method", code: 0 } });

function makeChain(endpoints) {
  return new GramHttpChain(endpoints, "", ZERO_ADDR, "", "", 1);
}

function classification() {
  for (const t of [
    "Request failed with status code 500",
    "Request failed with status code 502",
    "Request failed with status code 429",
    "timeout of 30000ms exceeded",
    "read ETIMEDOUT",
    "ECONNRESET",
    "socket hang up",
    "getaddrinfo EAI_AGAIN toncenter.com",
    "Network Error",
  ]) {
    assert.ok(isTransientTonError(new Error(t)), `should be transient: ${t}`);
  }
  for (const t of [
    'Received error: {"ok":false,"error":"unable to execute get method"}',
    "Malformed response: invalid address",
    "Invalid address",
  ]) {
    assert.ok(!isTransientTonError(new Error(t)), `must NOT be transient: ${t}`);
  }
  console.log("[gram-failover] isTransientTonError classification OK");
}

async function rotatesToHealthyEndpoint() {
  const a = await tonServer(http500); // endpoint0 5xx
  const b = await tonServer(ok(424242)); // endpoint1 healthy
  const chain = makeChain([a.url, b.url]);
  const h = await chain.finalizedHeight();
  assert.strictEqual(h, 424242, "should read latestSeqno from the healthy endpoint");
  assert.strictEqual(a.requests(), 1, `endpoint0 tried once then rotated away; saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 1, `endpoint1 served the retry; saw ${b.requests()}`);
  // Sticky idx: the NEXT read starts on endpoint1 (last-good), not back at endpoint0.
  await chain.finalizedHeight();
  assert.strictEqual(a.requests(), 1, `endpoint0 not revisited (sticky idx); saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 2, `endpoint1 serves the sticky follow-up; saw ${b.requests()}`);
  a.close(); b.close();
  console.log("[gram-failover] transient endpoint0 -> rotate to endpoint1, idx sticky OK");
}

async function appErrorDoesNotRotate() {
  const a = await tonServer(appError); // HTTP 200 ok:false — a genuine chain/app result
  const b = await tonServer(ok(1));
  const chain = makeChain([a.url, b.url]);
  await assert.rejects(() => chain.finalizedHeight(), "an application error must propagate");
  assert.strictEqual(a.requests(), 1, `app error must NOT rotate; endpoint0 saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 0, `endpoint1 must never be contacted on an app error; saw ${b.requests()}`);
  a.close(); b.close();
  console.log("[gram-failover] application error fails closed without rotating OK");
}

async function allDownOnePassThenThrow() {
  const a = await tonServer(http500);
  const b = await tonServer(http500);
  const c = await tonServer(http500);
  const chain = makeChain([a.url, b.url, c.url]);
  await assert.rejects(() => chain.finalizedHeight(), "all endpoints down must throw");
  // One pass through the ring: attempts == endpoint count (3), one request each.
  assert.strictEqual(a.requests(), 1, `endpoint0 saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 1, `endpoint1 saw ${b.requests()}`);
  assert.strictEqual(c.requests(), 1, `endpoint2 saw ${c.requests()}`);
  a.close(); b.close(); c.close();
  console.log("[gram-failover] all endpoints down -> one pass through the ring then throw OK");
}

async function singleEndpointUnchanged() {
  const a = await tonServer(http500);
  const chain = makeChain(a.url); // bare string == singleton list
  await assert.rejects(() => chain.finalizedHeight());
  assert.strictEqual(a.requests(), 1, `single endpoint = one attempt, no added retry; saw ${a.requests()}`);
  a.close();
  console.log("[gram-failover] single endpoint behaves exactly as today (1 request) OK");
}

async function apiKeyOnlyForToncenter() {
  const srv = await tonServer(ok(7));
  // Same server, different paths: the gate is /toncenter/i over the full endpoint string.
  const clients = buildTonClients([`${srv.url}/toncenter/api`, `${srv.url}/orbs/api`], "SECRETKEY", 10_000);
  assert.strictEqual(clients.length, 2, "one client per endpoint");
  await clients[0].getMasterchainInfo();
  assert.strictEqual(srv.lastApiKey(), "SECRETKEY", "toncenter endpoint must carry the API key");
  await clients[1].getMasterchainInfo();
  assert.strictEqual(srv.lastApiKey(), null, "Orbs/non-toncenter endpoint must NOT carry the API key");
  srv.close();
  console.log("[gram-failover] GRAM_API_KEY applied only to toncenter-host endpoints OK");
}

(async () => {
  classification();
  await rotatesToHealthyEndpoint();
  await appErrorDoesNotRotate();
  await allDownOnePassThenThrow();
  await singleEndpointUnchanged();
  await apiKeyOnlyForToncenter();
  console.log("[gram-failover] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
