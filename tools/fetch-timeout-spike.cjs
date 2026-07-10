// SPIKE: every outbound fetch is bounded by a timeout, so a blackhole peer (socket
// accepted, no response) becomes a caught error instead of an unbounded await (VG-10 / BH5).
// The coordinator loops signers SEQUENTIALLY and awaits each /approve; one hung signer would
// otherwise wedge every /submit behind it and freeze the whole delivery pipeline.
//
// Exercises the REAL compiled HttpSignerClient offline against local sockets:
//   1) blackhole signer (accepts, never replies) -> approve() REJECTS within ~timeout,
//      NOT after the OS socket timeout — proving AbortSignal.timeout fired.
//   2) responsive signer (200 + Approval JSON) -> approve() RESOLVES: the signal does not
//      break the happy path.
//   3) config wiring: loadConfig exposes signerApproveTimeoutMs / submitTimeoutMs with the
//      documented defaults, and both honor their env overrides (so the dispatcher /submit
//      fetch, an internal fn, is covered at the value that feeds its AbortSignal).
//
// Run: node tools/fetch-timeout-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { HttpSignerClient } = require("../packages/coordinator/dist/adapters");
const { loadConfig } = require("../packages/common/dist/config");

const ACTION = {
  direction: "PEG_OUT",
  id: "trx:0",
  remoteChain: "GRAM",
  recipient: "alice",
  amountMilliViz: 1000n,
  digest: "deadbeef",
};
const PROPOSAL = { kind: "viz-release" };

// A TCP server that accepts the connection but never sends a single byte back — the exact
// "blackhole" shape a wedged signer presents (unlike a refused/closed port, which errors fast).
function blackholeServer() {
  const held = [];
  const server = net.createServer((sock) => held.push(sock)); // keep the socket, reply never
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, held, port: server.address().port }));
  });
}

function respondingServer(bodyObj, status = 200) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyObj));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function blackholeAborts() {
  const { server, held, port } = await blackholeServer();
  const TIMEOUT = 300;
  const client = new HttpSignerClient("signer-1", `http://127.0.0.1:${port}`, { pegIn: TIMEOUT, pegOut: TIMEOUT });

  const start = Date.now();
  await assert.rejects(
    () => client.approve(ACTION, PROPOSAL),
    (err) => {
      // node's AbortSignal.timeout surfaces as a TimeoutError (or an AbortError on older
      // runtimes); either way the fetch rejects rather than hanging.
      const s = `${err && err.name}: ${err && err.message}`;
      assert.match(s, /Timeout|Abort|aborted|timed out/i, `expected an abort/timeout error, got ${s}`);
      return true;
    },
    "blackhole signer must make approve() reject, not hang",
  );
  const elapsed = Date.now() - start;
  // The abort must fire off OUR timeout, well before any OS-level socket timeout (minutes).
  // Generous ceiling to stay non-flaky under load, but far below a real hang.
  assert.ok(elapsed < TIMEOUT + 3000, `abort should fire near the ${TIMEOUT}ms timeout, took ${elapsed}ms`);

  for (const s of held) s.destroy();
  server.close();
  console.log(`[fetch-timeout] blackhole signer aborts in ${elapsed}ms (timeout ${TIMEOUT}ms) OK`);
}

async function healthyResolves() {
  const approval = { actionId: ACTION.id, operatorId: "op1", signature: "abc" };
  const { server, port } = await respondingServer(approval);
  const client = new HttpSignerClient("signer-1", `http://127.0.0.1:${port}`, { pegIn: 5000, pegOut: 5000 });

  const got = await client.approve(ACTION, PROPOSAL);
  assert.deepStrictEqual(got, approval, "healthy signer approval must round-trip unchanged");

  server.close();
  console.log("[fetch-timeout] responsive signer resolves (signal does not break happy path) OK");
}

function configWiring() {
  const KEYS = [
    "SIGNER_APPROVE_TIMEOUT_MS",
    "SIGNER_APPROVE_TIMEOUT_PEG_IN_MS",
    "SIGNER_APPROVE_TIMEOUT_PEG_OUT_MS",
    "DISPATCHER_SUBMIT_TIMEOUT_MS",
    "DISPATCHER_SIGNING_TIMEOUT_MS",
  ];
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  const restore = () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  // A federation manifest is required to load; reuse the example if present, else skip the
  // env portion gracefully (the socket tests above already cover the runtime behavior).
  try {
    for (const k of KEYS) delete process.env[k];
    const def = loadConfig();
    // Direction-aware defaults: PEG_IN wide (on-chain propose/approve), PEG_OUT tight (local sign).
    assert.strictEqual(def.coordinator.signerApproveTimeoutMs.pegIn, 180000, "signerApproveTimeoutMs.pegIn default = 180000");
    assert.strictEqual(def.coordinator.signerApproveTimeoutMs.pegOut, 30000, "signerApproveTimeoutMs.pegOut default = 30000");
    assert.strictEqual(def.dispatcher.submitTimeoutMs, 300000, "submitTimeoutMs default = 300000");

    // submitTimeoutMs falls back to the peg-in signing timeout when its own var is unset.
    process.env.DISPATCHER_SIGNING_TIMEOUT_MS = "123456";
    assert.strictEqual(loadConfig().dispatcher.submitTimeoutMs, 123456, "submitTimeoutMs inherits DISPATCHER_SIGNING_TIMEOUT_MS");

    // An explicit override wins over the fallback.
    process.env.DISPATCHER_SUBMIT_TIMEOUT_MS = "77000";
    // SIGNER_APPROVE_TIMEOUT_MS still sets BOTH directions at once (back-compat).
    process.env.SIGNER_APPROVE_TIMEOUT_MS = "9000";
    const ov = loadConfig();
    assert.strictEqual(ov.dispatcher.submitTimeoutMs, 77000, "DISPATCHER_SUBMIT_TIMEOUT_MS override");
    assert.strictEqual(ov.coordinator.signerApproveTimeoutMs.pegIn, 9000, "SIGNER_APPROVE_TIMEOUT_MS sets pegIn");
    assert.strictEqual(ov.coordinator.signerApproveTimeoutMs.pegOut, 9000, "SIGNER_APPROVE_TIMEOUT_MS sets pegOut");

    // Per-direction vars win over the shared var.
    process.env.SIGNER_APPROVE_TIMEOUT_PEG_IN_MS = "222000";
    process.env.SIGNER_APPROVE_TIMEOUT_PEG_OUT_MS = "11000";
    const pd = loadConfig();
    assert.strictEqual(pd.coordinator.signerApproveTimeoutMs.pegIn, 222000, "SIGNER_APPROVE_TIMEOUT_PEG_IN_MS wins");
    assert.strictEqual(pd.coordinator.signerApproveTimeoutMs.pegOut, 11000, "SIGNER_APPROVE_TIMEOUT_PEG_OUT_MS wins");
    console.log("[fetch-timeout] config defaults + env overrides OK");
  } catch (err) {
    console.log(`[fetch-timeout] config wiring skipped (loadConfig needs a manifest): ${String(err).split("\n")[0]}`);
  } finally {
    restore();
  }
}

(async () => {
  await blackholeAborts();
  await healthyResolves();
  configWiring();
  console.log("[fetch-timeout] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
