// SPIKE: the VIZ read path FAILS OVER across a node list on TRANSIENT errors. VIZ_NODE_URL
// may carry several nodes (node.viz.cx,api.viz.world,mirror.viz.world); on a 5xx/timeout/
// rate-limit spike VizJsChain rotates to the next node and retries, so one provider blip can't
// latch recon into an indeterminate "cannot verify backing" pause (the 2026-07-27 incident).
//
// viz.config ("websocket") is a viz-js-lib PROCESS-GLOBAL singleton, so failover re-sets it per
// attempt rather than holding N clients. This exercises the REAL compiled VizJsChain against
// several local JSON-RPC servers and asserts WHICH node served each attempt:
//   1) node0 transient-fails, node1 healthy -> rotate to node1 -> succeed (node1 served it).
//   2) sticky idx: the NEXT call starts on node1 (the last-good node), not back at node0.
//   3) non-transient (app) error throws WITHOUT rotating (only node0 is contacted).
//   4) rotate-per-attempt cycles the ring: 3 all-502 nodes over 4 attempts hit A,B,C,A.
//   5) single node == today: 4 attempts, all on the one node, then throw.
//
// Run: node tools/viz-rpc-failover-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const { VizJsChain, RPC_MAX_ATTEMPTS } = require("../packages/viz-watcher/dist/vizChain");
const { buildGatewayAccounts, loadConfig } = require("../packages/common/dist");

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

const okGdgpBody = (id) => ({ jsonrpc: "2.0", id, result: { last_irreversible_block_num: 424242 } });
const appErrBody = (id) => ({ jsonrpc: "2.0", id, error: { code: 10, message: "unknown transaction" } });

// A JSON-RPC server whose response is decided by `plan(n, id)` (1-based per-server request #).
function rpcServer(plan) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n += 1;
      let reqId = 1;
      try { reqId = JSON.parse(raw).id ?? 1; } catch { /* non-JSON */ }
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

const always502 = () => ({ status: 502, body: "Bad Gateway" });
const always200 = (_n, id) => ({ status: 200, body: okGdgpBody(id) });

async function rotatesToHealthyNode() {
  const a = await rpcServer(always502); // node0 always transient-fails
  const b = await rpcServer(always200); // node1 healthy
  const chain = new VizJsChain([a.url, b.url], accounts());
  const lib = await chain.lastIrreversibleBlock();
  assert.strictEqual(lib, 424242, "should return the LIB from the healthy node");
  assert.strictEqual(a.requests(), 1, `node0 tried once then rotated away; saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 1, `node1 served the retry; saw ${b.requests()}`);
  // Sticky idx: the NEXT call must start on node1 (last-good), NOT node0.
  await chain.lastIrreversibleBlock();
  assert.strictEqual(a.requests(), 1, `node0 must not be revisited (sticky idx); saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 2, `node1 serves the sticky follow-up; saw ${b.requests()}`);
  a.close(); b.close();
  console.log("[viz-failover] transient node0 -> rotate to node1, idx sticky OK");
}

async function nonTransientDoesNotRotate() {
  const a = await rpcServer((_n, id) => ({ status: 200, body: appErrBody(id) })); // app error
  const b = await rpcServer(always200);
  const chain = new VizJsChain([a.url, b.url], accounts());
  await assert.rejects(() => chain.lastIrreversibleBlock(), "a non-transient error must propagate");
  assert.strictEqual(a.requests(), 1, `app error must NOT retry/rotate; node0 saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 0, `node1 must never be contacted on an app error; saw ${b.requests()}`);
  a.close(); b.close();
  console.log("[viz-failover] non-transient error fails closed without rotating OK");
}

async function cyclesRingOverAttempts() {
  // All three nodes 502: 4 attempts rotate A(1) -> B(2) -> C(3) -> A(4), then throw.
  const a = await rpcServer(always502);
  const b = await rpcServer(always502);
  const c = await rpcServer(always502);
  const chain = new VizJsChain([a.url, b.url, c.url], accounts());
  await assert.rejects(() => chain.lastIrreversibleBlock(), /502/, "all-nodes-down must eventually throw");
  assert.strictEqual(RPC_MAX_ATTEMPTS, 4, "4 attempts expected");
  assert.strictEqual(a.requests(), 2, `A served attempts 1 and 4; saw ${a.requests()}`);
  assert.strictEqual(b.requests(), 1, `B served attempt 2; saw ${b.requests()}`);
  assert.strictEqual(c.requests(), 1, `C served attempt 3; saw ${c.requests()}`);
  a.close(); b.close(); c.close();
  console.log("[viz-failover] rotate-per-attempt cycles the node ring OK");
}

async function singleNodeUnchanged() {
  const a = await rpcServer(always502);
  const chain = new VizJsChain(a.url, accounts()); // bare string == singleton list
  await assert.rejects(() => chain.lastIrreversibleBlock(), /502/);
  assert.strictEqual(a.requests(), RPC_MAX_ATTEMPTS, `single node keeps 4 attempts; saw ${a.requests()}`);
  a.close();
  console.log("[viz-failover] single node behaves exactly as today (4 attempts, no rotation) OK");
}

(async () => {
  await rotatesToHealthyNode();
  await nonTransientDoesNotRotate();
  await cyclesRingOverAttempts();
  await singleNodeUnchanged();
  console.log("[viz-failover] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
