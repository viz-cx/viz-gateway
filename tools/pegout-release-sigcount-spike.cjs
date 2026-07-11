// SPIKE: the VIZ peg-out release attaches EXACTLY the gateway account's active
// weight_threshold signatures — never more. The federation can collect more approvals
// than the VIZ account's authority needs: `federation-live.ts` forces a 3-of-3 federation
// (so three operators reach a remote 3-of-5 minter on peg-IN), but the same operators are
// a 2-of-3 authority on the VIZ gateway account. VIZ/graphene rejects a transfer that
// carries a signature beyond its minimal satisfying set ("irrelevant signature included"),
// and an ASYNC broadcastTransaction never surfaces that apply-time rejection — the release
// is accepted into the pending pool, dropped at block production, and silently never lands
// (observed live: "viz release <txid> not confirmed after 60s", retried forever). So
// broadcastRelease MUST trim to weight_threshold before broadcasting.
//
// Exercises the REAL compiled VizJsChain.broadcastRelease offline against a local JSON-RPC
// server that serves get_accounts (a 2-of-3 authority), records the broadcast tx, and
// confirms get_transaction so the poll resolves on the first tick:
//   1) 3 collected sigs + 2-of-3 authority -> broadcast tx carries EXACTLY 2 sigs, and the
//      returned txid equals the deterministic releaseTxId (unaffected by the trim).
//   2) exactly-threshold (2 sigs) is unchanged -> 2 sigs broadcast.
//   3) fewer sigs than the authority needs (1 sig, 2-of-3) -> throws BEFORE broadcasting
//      (no partial transfer put on the wire).
//
// Run: node tools/pegout-release-sigcount-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const { VizJsChain } = require("../packages/viz-watcher/dist/vizChain");
const { releaseTxId } = require("../packages/viz-watcher/dist/vizSign");
const { buildGatewayAccounts, loadConfig } = require("../packages/common/dist");

// Minimal gateway-accounts registry so the VizJsChain constructor is satisfied; the release
// path under test doesn't consult it, so a single mapping is enough.
function accounts() {
  const KEYS = ["VIZ_GATEWAY_ACCOUNT_GRAM", "VIZ_GATEWAY_ACCOUNT_SOLANA", "FEDERATION_N", "FEDERATION_THRESHOLD"];
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.VIZ_GATEWAY_ACCOUNT_GRAM = "gw";
  process.env.VIZ_GATEWAY_ACCOUNT_SOLANA = "gw.sol";
  process.env.FEDERATION_N = "3";
  process.env.FEDERATION_THRESHOLD = "3";
  try {
    return buildGatewayAccounts(loadConfig());
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// A 2-of-3 active authority: three equal-weight (weight 1) operator keys, threshold 2.
const ACTIVE_AUTHORITY = {
  weight_threshold: 2,
  account_auths: [],
  key_auths: [
    ["VIZ65QRpXcP5TC4grAoB58U4JUSwr7TyPdJoEewYSFLEXf1jgCoJy", 1],
    ["VIZ8KDgP7NqqSJDag78tGco7f5vrM4EFwqSoA2qoeX4CkwNkM5U5G", 1],
    ["VIZ7UADKgSGMedvKCGPzkquaJd7AP7w3EPXmqLVdvRQV58T45cmjK", 1],
  ],
};

const PROPOSAL = {
  refBlockNum: 4242,
  refBlockPrefix: 12345678,
  expiration: "2030-01-01T00:00:00",
  from: "gw",
  to: "babin",
  amount: "15.904 VIZ",
  memo: "fe9880faacc40754336c8452039363a45903ddc19e5c495ed16b64bcb091666b",
};

// JSON-RPC server dispatching on the inner graphene method name (params = [api, method,
// args]). Serves the 2-of-3 account, records the broadcast tx, and confirms any
// get_transaction so confirmReleaseByTxId resolves on the first poll tick.
function nodeServer() {
  let lastBroadcast = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const msg = JSON.parse(raw);
      const id = msg.id ?? 1;
      const [, method, args] = msg.params; // ["call", [api, method, args]] -> outer.params
      let result;
      if (method === "get_accounts") {
        result = [{ name: "gw", balance: "100.000 VIZ", active_authority: ACTIVE_AUTHORITY }];
      } else if (method === "broadcast_transaction") {
        lastBroadcast = args[0];
        result = {};
      } else if (method === "get_transaction") {
        result = { block_num: 1, transaction_id: args[0] }; // truthy => confirmed
      } else {
        result = null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        lastBroadcast: () => lastBroadcast,
        reset: () => (lastBroadcast = null),
        close: () => server.close(),
      }),
    );
  });
}

async function trimsToThreshold(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  const sigs = ["sigA", "sigB", "sigC"]; // 3 collected, authority needs 2
  const txid = await chain.broadcastRelease(PROPOSAL, sigs);
  const tx = srv.lastBroadcast();
  assert.ok(tx, "a transaction must have been broadcast");
  assert.strictEqual(tx.signatures.length, 2, `must broadcast exactly 2 sigs, saw ${tx.signatures.length}`);
  assert.deepStrictEqual(tx.signatures, ["sigA", "sigB"], "keeps the first weight_threshold sigs");
  assert.strictEqual(txid, releaseTxId(PROPOSAL), "txid is the deterministic id (trim does not change it)");
  console.log("[pegout-sigcount] 3 sigs + 2-of-3 -> broadcasts exactly 2 sigs, deterministic txid OK");
}

async function exactThresholdUnchanged(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  await chain.broadcastRelease(PROPOSAL, ["sigA", "sigB"]);
  assert.strictEqual(srv.lastBroadcast().signatures.length, 2, "exactly-threshold passes through untrimmed");
  console.log("[pegout-sigcount] 2 sigs + 2-of-3 -> broadcasts 2 sigs OK");
}

async function tooFewThrowsBeforeBroadcast(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  await assert.rejects(
    () => chain.broadcastRelease(PROPOSAL, ["sigA"]),
    /have 1 signatures, authority needs 2/,
    "fewer sigs than the authority needs must throw",
  );
  assert.strictEqual(srv.lastBroadcast(), null, "must NOT put a sub-threshold transfer on the wire");
  console.log("[pegout-sigcount] 1 sig + 2-of-3 -> throws before broadcasting OK");
}

(async () => {
  const srv = await nodeServer();
  try {
    await trimsToThreshold(srv);
    await exactThresholdUnchanged(srv);
    await tooFewThrowsBeforeBroadcast(srv);
    console.log("[pegout-sigcount] ALL OK");
  } finally {
    srv.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
