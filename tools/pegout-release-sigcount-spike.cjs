// SPIKE: the VIZ peg-out release attaches a MINIMAL in-authority signature set — the
// signatures whose recovered keys are actually in the gateway account's active authority,
// up to its weight_threshold, and never one more. The federation can collect more approvals
// than the VIZ account's authority needs: `federation-live.ts` forces a 3-of-3 federation
// (so three operators reach a remote 3-of-5 minter on peg-IN), but the same operators are
// a 2-of-3 authority on the VIZ gateway account. VIZ/graphene rejects a transfer that
// carries a signature beyond its minimal satisfying set ("irrelevant signature included"),
// and an ASYNC broadcastTransaction never surfaces that apply-time rejection — the release
// is accepted into the pending pool, dropped at block production, and silently never lands
// (observed live: "viz release <txid> not confirmed after 60s", retried forever).
//
// broadcastRelease attributes each collected signature to a key via secp256k1 recovery, so
// it is robust to collection ORDER and to a federation/authority mismatch — a signature from
// an operator whose key is not (or not yet, mid-rotation) in the active authority is ignored
// rather than blindly sliced into the broadcast. Exercises the REAL compiled
// VizJsChain.broadcastRelease with REAL operator signatures, offline against a local JSON-RPC
// server that serves get_accounts (a 2-of-3 authority), records the broadcast tx, and
// confirms get_transaction so the poll resolves on the first tick:
//   1) 3 valid sigs + 2-of-3 authority -> broadcast tx carries EXACTLY 2 sigs, and the
//      returned txid equals the deterministic releaseTxId (unaffected by the trim).
//   2) exactly-threshold (2 sigs) is unchanged -> 2 sigs broadcast.
//   3) an out-of-authority signature FIRST in the collected order ([D, A, B]) -> D is
//      ignored, the two in-authority sigs (A, B) are broadcast (order-robust hardening).
//   4) a duplicate signature ([A, A, B]) -> the repeat is skipped, A + B broadcast.
//   5) too few relevant sigs (1 in-authority, or only outsiders) -> throws BEFORE
//      broadcasting (no partial transfer put on the wire).
//
// Run: node tools/pegout-release-sigcount-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const viz = require("viz-js-lib");
const { VizJsChain } = require("../packages/viz-watcher/dist/vizChain");
const { releaseTxId, signRelease } = require("../packages/viz-watcher/dist/vizSign");
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

// Three in-authority operator keypairs (A, B, C) plus an OUTSIDER (D) whose key is not in
// the authority — stand-in for a federation member not (yet) added to this account.
const keypair = (seed) => {
  const wif = viz.auth.toWif("gateway", `password-${seed}`, "active");
  return { wif, pub: viz.auth.wifToPublic(wif) };
};
const A = keypair("op1");
const B = keypair("op2");
const C = keypair("op3");
const D = keypair("outsider");

// A 2-of-3 active authority over A, B, C (equal weight 1). D is deliberately absent.
const ACTIVE_AUTHORITY = {
  weight_threshold: 2,
  account_auths: [],
  key_auths: [
    [A.pub, 1],
    [B.pub, 1],
    [C.pub, 1],
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

// Real signatures over the exact proposal bytes — recoverable to each operator's key.
const sigA = signRelease(PROPOSAL, A.wif);
const sigB = signRelease(PROPOSAL, B.wif);
const sigC = signRelease(PROPOSAL, C.wif);
const sigD = signRelease(PROPOSAL, D.wif);

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
  const txid = await chain.broadcastRelease(PROPOSAL, [sigA, sigB, sigC]); // 3 collected, needs 2
  const tx = srv.lastBroadcast();
  assert.ok(tx, "a transaction must have been broadcast");
  assert.strictEqual(tx.signatures.length, 2, `must broadcast exactly 2 sigs, saw ${tx.signatures.length}`);
  assert.deepStrictEqual(tx.signatures, [sigA, sigB], "keeps the first weight_threshold in-authority sigs");
  assert.strictEqual(txid, releaseTxId(PROPOSAL), "txid is the deterministic id (trim does not change it)");
  console.log("[pegout-sigcount] 3 sigs + 2-of-3 -> broadcasts exactly 2 sigs, deterministic txid OK");
}

async function exactThresholdUnchanged(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  await chain.broadcastRelease(PROPOSAL, [sigA, sigB]);
  assert.strictEqual(srv.lastBroadcast().signatures.length, 2, "exactly-threshold passes through untrimmed");
  console.log("[pegout-sigcount] 2 sigs + 2-of-3 -> broadcasts 2 sigs OK");
}

async function ignoresOutsiderSigFirst(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  // The harmful case a blind slice(0, threshold) would mishandle: an out-of-authority
  // signature at the FRONT of the collected order. Recovery attributes D to no authority
  // key, so it's skipped and the two real sigs are broadcast — the release still lands.
  await chain.broadcastRelease(PROPOSAL, [sigD, sigA, sigB]);
  assert.deepStrictEqual(srv.lastBroadcast().signatures, [sigA, sigB], "outsider sig ignored, A+B broadcast");
  console.log("[pegout-sigcount] [D,A,B] + 2-of-3 -> ignores outsider, broadcasts A+B OK");
}

async function skipsDuplicateSig(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  // A repeated signature recovers to the same key and must not double-count toward weight.
  await chain.broadcastRelease(PROPOSAL, [sigA, sigA, sigB]);
  assert.deepStrictEqual(srv.lastBroadcast().signatures, [sigA, sigB], "duplicate A skipped, A+B broadcast");
  console.log("[pegout-sigcount] [A,A,B] + 2-of-3 -> skips duplicate, broadcasts A+B OK");
}

async function tooFewThrowsBeforeBroadcast(srv) {
  srv.reset();
  const chain = new VizJsChain(srv.url, accounts());
  await assert.rejects(
    () => chain.broadcastRelease(PROPOSAL, [sigA]),
    /relevant signatures reach weight 1, active authority needs 2/,
    "one in-authority sig for a 2-of-3 must throw",
  );
  assert.strictEqual(srv.lastBroadcast(), null, "must NOT put a sub-threshold transfer on the wire");
  // Only outsiders => zero relevant weight => also throws, nothing on the wire.
  await assert.rejects(
    () => chain.broadcastRelease(PROPOSAL, [sigD, sigD]),
    /relevant signatures reach weight 0, active authority needs 2/,
    "only out-of-authority sigs must throw",
  );
  assert.strictEqual(srv.lastBroadcast(), null, "outsider-only set must not broadcast");
  console.log("[pegout-sigcount] 1 in-authority sig (and outsiders-only) -> throws before broadcasting OK");
}

(async () => {
  const srv = await nodeServer();
  try {
    await trimsToThreshold(srv);
    await exactThresholdUnchanged(srv);
    await ignoresOutsiderSigFirst(srv);
    await skipsDuplicateSig(srv);
    await tooFewThrowsBeforeBroadcast(srv);
    console.log("[pegout-sigcount] ALL OK");
  } finally {
    srv.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
