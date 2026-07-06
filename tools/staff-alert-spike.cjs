// SPIKE: operator alerting has a real, retrying, fail-loud transport (VG BH4).
// notifyStaff used to be a red log line in a file nobody tails — every fail-closed pause
// (cap breach, scan truncation, wedged delivery) routed to a silent sink. Exercises the
// real deliverStaffWebhook + health flag offline:
//   1) a 2xx endpoint -> delivered on the first attempt (no needless retries).
//   2) an always-500 endpoint -> false after exactly retries+1 attempts (bounded).
//   3) 500 then 200 -> retried and delivered; attempts stop at the first success.
//   4) a blackhole endpoint (socket accepted, no response) -> false via the per-attempt
//      timeout, in bounded wall-clock (not a hang).
//   5) isAlertingHealthy() defaults true and the test-reset seam works.
//
// Run: node tools/staff-alert-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const {
  deliverStaffWebhook,
  isAlertingHealthy,
  __resetAlertingHealthForTest,
} = require("../packages/log/dist");

const FAST = { retries: 3, retryDelayMs: 1, timeoutMs: 300 };

// A fetch stand-in driven by a scripted sequence of outcomes. Each element is either an
// HTTP status number (-> {ok, status}) or "throw" (-> network error).
function scriptedFetch(seq) {
  const calls = { n: 0 };
  const fn = async () => {
    const outcome = seq[Math.min(calls.n, seq.length - 1)];
    calls.n++;
    if (outcome === "throw") throw new Error("ECONNREFUSED");
    return { ok: outcome >= 200 && outcome < 300, status: outcome };
  };
  return { fn, calls };
}

async function deliversFirstTry() {
  const { fn, calls } = scriptedFetch([200]);
  const ok = await deliverStaffWebhook("http://x", "withdraws", "msg", {}, { ...FAST, fetchImpl: fn });
  assert.strictEqual(ok, true, "2xx delivers");
  assert.strictEqual(calls.n, 1, "no retry after a first-attempt success");
  console.log("[staff-alert] 2xx delivered on first attempt OK");
}

async function failsAfterRetries() {
  const { fn, calls } = scriptedFetch([500]);
  const ok = await deliverStaffWebhook("http://x", "withdraws", "msg", {}, { ...FAST, fetchImpl: fn });
  assert.strictEqual(ok, false, "always-500 fails");
  assert.strictEqual(calls.n, FAST.retries + 1, "exactly retries+1 attempts, then gives up");
  console.log("[staff-alert] always-500 fails after retries+1 attempts OK");
}

async function retriesThenSucceeds() {
  const { fn, calls } = scriptedFetch([500, "throw", 200, 200]);
  const ok = await deliverStaffWebhook("http://x", "drift", "msg", {}, { ...FAST, fetchImpl: fn });
  assert.strictEqual(ok, true, "recovers once the endpoint returns 2xx");
  assert.strictEqual(calls.n, 3, "stops at the first success (attempt 3)");
  console.log("[staff-alert] 500/throw then 200 -> delivered, stops at success OK");
}

async function realServerRoundTrips() {
  let received = null;
  const server = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      received = JSON.parse(buf);
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ok = await deliverStaffWebhook(`http://127.0.0.1:${port}`, "reserve", "low SOL", { lamports: 42 }, FAST);
  assert.strictEqual(ok, true, "real POST delivers");
  assert.strictEqual(received.scope, "reserve", "scope forwarded");
  assert.strictEqual(received.message, "low SOL", "message forwarded");
  assert.deepStrictEqual(received.meta, { lamports: 42 }, "meta forwarded");
  assert.strictEqual(typeof received.ts, "number", "timestamp attached");
  server.close();
  console.log("[staff-alert] real webhook round-trips scope/message/meta/ts OK");
}

async function blackholeTimesOut() {
  const held = [];
  const server = net.createServer((s) => held.push(s)); // accept, never reply
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const start = Date.now();
  const ok = await deliverStaffWebhook(`http://127.0.0.1:${port}`, "delivery", "msg", {}, { retries: 1, retryDelayMs: 1, timeoutMs: 250 });
  const elapsed = Date.now() - start;
  assert.strictEqual(ok, false, "blackhole endpoint fails (does not hang)");
  // 2 attempts * ~250ms timeout; generous ceiling to stay non-flaky, far below a real hang.
  assert.ok(elapsed < 3000, `bounded by the timeout, took ${elapsed}ms`);
  for (const s of held) s.destroy();
  server.close();
  console.log(`[staff-alert] blackhole endpoint fails via timeout in ${elapsed}ms OK`);
}

function healthFlag() {
  __resetAlertingHealthForTest();
  assert.strictEqual(isAlertingHealthy(), true, "alerting healthy by default");
  console.log("[staff-alert] health flag default + reset seam OK");
}

(async () => {
  healthFlag();
  await deliversFirstTry();
  await failsAfterRetries();
  await retriesThenSucceeds();
  await realServerRoundTrips();
  await blackholeTimesOut();
  console.log("[staff-alert] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
