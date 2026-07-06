// SPIKE: @gateway/log must never crash a service on startup because LOG_DIR is unwritable (BH).
// The rotating file transport (winston-daily-rotate-file) does its OWN mkdir on the configured
// dirname; a relative "./logs" under a non-root container resolves to an unwritable CWD and the
// mkdir throws UNCAUGHT ("EACCES mkdir 'logs/'"), killing every service. createLogger must decide
// up front: attach the file transport only when the dir is writable, else console-only, no throw.
//
// Run: node tools/log-dir-fallback-spike.cjs   (after npm run build)
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MOD = require.resolve("../packages/log/dist/index.js");
function freshLog() {
  delete require.cache[MOD]; // LOG_DIR is captured at module load → re-require to pick up new env
  return require(MOD);
}

function unwritableDirFailsToConsoleOnly() {
  // A read-only parent (0o500: r-x, no write) → mkdir of a subdir fails EACCES for the non-root user.
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "log-ro-"));
  fs.chmodSync(ro, 0o500);
  process.env.LOG_DIR = path.join(ro, "logs");
  let mod, lg;
  assert.doesNotThrow(() => { mod = freshLog(); }, "requiring @gateway/log with an unwritable LOG_DIR must not throw (staffLog is built at import)");
  assert.doesNotThrow(() => { lg = mod.createLogger("smoke"); }, "createLogger with an unwritable LOG_DIR must not throw");
  assert.strictEqual(lg.transports.length, 1, "unwritable dir → console transport only (no file transport)");
  fs.chmodSync(ro, 0o700); fs.rmSync(ro, { recursive: true, force: true });
  console.log("[log-dir-fallback] unwritable LOG_DIR → console-only, no crash OK");
}

function writableDirAttachesFileTransport() {
  const wr = fs.mkdtempSync(path.join(os.tmpdir(), "log-wr-"));
  process.env.LOG_DIR = wr;
  const mod = freshLog();
  const lg = mod.createLogger("smoke");
  assert.strictEqual(lg.transports.length, 2, "writable dir → console + rotating file transport");
  assert.ok(fs.existsSync(wr), "log dir exists");
  // NB: do NOT rm `wr` here — the rotating file transport opens its stream asynchronously; deleting
  // the dir out from under it emits an unhandled ENOENT 'error' that crashes the process AFTER the
  // assertions pass. The tmp dir is harmless (OS clears /tmp).
  console.log("[log-dir-fallback] writable LOG_DIR → file transport attached OK");
}

// Running as root would defeat the permission check (root bypasses mode bits) — skip loudly.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.log("[log-dir-fallback] SKIPPED unwritable case (running as root; mode bits bypassed)");
  writableDirAttachesFileTransport();
} else {
  unwritableDirFailsToConsoleOnly();
  writableDirAttachesFileTransport();
}
console.log("log-dir-fallback-spike: all assertions passed");
