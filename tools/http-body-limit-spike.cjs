// SPIKE: HTTP request bodies are bounded by size + timeout (VG BM4).
// The coordinator /submit and signer /approve handlers did `body += chunk` with no cap,
// no timeout, and no error handler — a multi-GB body OOMs the process and a half-open
// request pins the socket. Exercises the real readLimitedBody:
//   1) a normal body resolves intact.
//   2) a body over maxBytes rejects with BodyError(413) and destroys the socket.
//   3) a body that never ends rejects with BodyError(408) near the timeout, socket destroyed.
//   4) a stream error rejects with BodyError(400).
//   5) once settled, a late error does not double-settle / throw.
//   6) end-to-end over a real socket: an oversize POST gets a 413, a normal POST 200.
//
// Run: node tools/http-body-limit-spike.cjs   (after npm run build)
const assert = require("node:assert");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { readLimitedBody, BodyError } = require("../packages/common/dist/http");

function fakeReq() {
  const r = new EventEmitter();
  r.destroyed = false;
  r.destroy = () => {
    r.destroyed = true;
  };
  return r;
}

async function normalBodyResolves() {
  const req = fakeReq();
  const p = readLimitedBody(req, { maxBytes: 100, timeoutMs: 1000 });
  req.emit("data", Buffer.from("hello "));
  req.emit("data", Buffer.from("world"));
  req.emit("end");
  assert.strictEqual(await p, "hello world", "body reassembled intact");
  assert.strictEqual(req.destroyed, false, "clean read does not destroy the socket");
  console.log("[http-body] normal body resolves intact OK");
}

async function oversizeRejects413() {
  const req = fakeReq();
  const p = readLimitedBody(req, { maxBytes: 8, timeoutMs: 1000 });
  req.emit("data", Buffer.from("123456789")); // 9 bytes > 8
  await assert.rejects(p, (e) => e instanceof BodyError && e.statusCode === 413, "overflow => BodyError 413");
  assert.strictEqual(req.destroyed, true, "socket destroyed on overflow (stops the flood)");
  console.log("[http-body] oversize body => 413 + socket destroyed OK");
}

async function stalledRejects408() {
  const req = fakeReq();
  const start = Date.now();
  const p = readLimitedBody(req, { maxBytes: 1000, timeoutMs: 120 });
  req.emit("data", Buffer.from("partial")); // ...then never "end"
  await assert.rejects(p, (e) => e instanceof BodyError && e.statusCode === 408, "stall => BodyError 408");
  const elapsed = Date.now() - start;
  assert.strictEqual(req.destroyed, true, "socket destroyed on timeout (frees the half-open request)");
  assert.ok(elapsed < 2000, `fires near the timeout, took ${elapsed}ms`);
  console.log(`[http-body] half-open body => 408 in ${elapsed}ms + socket destroyed OK`);
}

async function streamErrorRejects400() {
  const req = fakeReq();
  const p = readLimitedBody(req, { maxBytes: 1000, timeoutMs: 1000 });
  req.emit("error", new Error("ECONNRESET"));
  await assert.rejects(p, (e) => e instanceof BodyError && e.statusCode === 400, "stream error => BodyError 400");
  console.log("[http-body] stream error => 400 OK");
}

async function settledOnceIsSafe() {
  const req = fakeReq();
  const p = readLimitedBody(req, { maxBytes: 1000, timeoutMs: 1000 });
  req.emit("data", Buffer.from("ok"));
  req.emit("end");
  assert.strictEqual(await p, "ok");
  // A late event after settlement must be a no-op, not an unhandled rejection or throw.
  req.emit("error", new Error("late"));
  req.emit("data", Buffer.from("more"));
  console.log("[http-body] settle-once guard ignores late events OK");
}

async function realSocketEndToEnd() {
  const server = http.createServer((req, res) => {
    void readLimitedBody(req, { maxBytes: 16, timeoutMs: 1000 }).then(
      (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ len: body.length }));
      },
      (err) => {
        res.writeHead(err instanceof BodyError ? err.statusCode : 400);
        res.end();
      },
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // Resolve to {status} on a response, or {reset:true} if the socket was torn down.
  const post = (payload) =>
    new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      r.on("error", () => resolve({ reset: true }));
      r.end(payload);
    });

  assert.deepStrictEqual(await post("small"), { status: 200 }, "normal POST accepted");
  // Oversize: readLimitedBody destroys the socket to hard-cut the flood, so the client sees a
  // reset (or, if the response wins the race, a 413) — never a normal 200, and the process
  // never buffers the flood. Either outcome proves the cap held.
  const big = await post("x".repeat(64));
  assert.ok(big.reset === true || big.status === 413, `oversize POST must reset or 413, got ${JSON.stringify(big)}`);
  server.close();
  console.log(`[http-body] real-socket: 200 for normal, ${big.reset ? "reset" : big.status} for oversize OK`);
}

(async () => {
  await normalBodyResolves();
  await oversizeRejects413();
  await stalledRejects408();
  await streamErrorRejects400();
  await settledOnceIsSafe();
  await realSocketEndToEnd();
  console.log("[http-body] ALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
