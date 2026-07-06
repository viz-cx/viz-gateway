// SPIKE: the deploy wiring is self-consistent (VG BH2/BH3).
// The container image is one binary that dispatches on $SERVICE via docker-entrypoint.sh.
// Two silent-death classes shipped: (1) an entrypoint case pointed at packages/ton-watcher
// (renamed to gram-watcher) -> MODULE_NOT_FOUND crash-loop; (2) a compose file set a SERVICE
// with no matching entrypoint case (or omitted the dispatcher entirely -> QUEUED never drains).
// This asserts, offline and with no docker, that:
//   1) every entrypoint case runs a file that actually exists in the source tree.
//   2) every `SERVICE:` in either compose file has a matching entrypoint case.
//   3) the delivery-critical services (dispatcher, gram-watcher) are wired in the operator compose.
//   4) no compose references the dead `ton-watcher` name.
//
// Run: node tools/deploy-consistency-spike.cjs
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const entrypoint = fs.readFileSync(path.join(ROOT, "docker-entrypoint.sh"), "utf8");

// Parse `  <label>)  exec node packages/<pkg>/dist/<file>.js ;;`
const cases = {};
for (const m of entrypoint.matchAll(/^\s*([a-z0-9-]+)\)\s+exec node (\S+)\s*;;/gm)) {
  cases[m[1]] = m[2];
}
assert.ok(Object.keys(cases).length >= 8, `expected the full service set in entrypoint, got ${Object.keys(cases).join(",")}`);

// 1) each case's dist path maps to an existing source file (dist/X.js <- src/X.ts).
for (const [label, distPath] of Object.entries(cases)) {
  const srcPath = distPath.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
  assert.ok(fs.existsSync(path.join(ROOT, srcPath)), `entrypoint '${label}' runs ${distPath} but ${srcPath} does not exist`);
}
console.log(`[deploy-consistency] all ${Object.keys(cases).length} entrypoint cases map to real sources OK`);

// 4) the renamed-away package must not reappear anywhere in entrypoint.
assert.ok(!/\bton-watcher\b/.test(entrypoint), "entrypoint still references the removed 'ton-watcher'");
assert.ok(cases["gram-watcher"], "entrypoint missing the gram-watcher case (TON burn watcher)");
console.log("[deploy-consistency] no dead ton-watcher reference; gram-watcher present OK");

// 2) + 4) every SERVICE in every compose file resolves to an entrypoint case (and isn't ton-watcher).
const composeFiles = ["docker-compose.yml", "docker-compose.coordinator.yml"];
const seenServices = new Set();
for (const f of composeFiles) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of text.matchAll(/^\s*SERVICE:\s*([a-z0-9-]+)\s*$/gm)) {
    const svc = m[1];
    seenServices.add(svc);
    assert.ok(cases[svc], `${f}: SERVICE '${svc}' has no matching entrypoint case`);
    assert.notStrictEqual(svc, "ton-watcher", `${f}: still uses the dead 'ton-watcher' SERVICE`);
  }
}
console.log(`[deploy-consistency] every compose SERVICE (${[...seenServices].join(",")}) has an entrypoint case OK`);

// 3) the operator stack must include the delivery-critical services, or peg-ins/outs never land.
const operator = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
for (const required of ["dispatcher", "gram-watcher"]) {
  assert.ok(new RegExp(`SERVICE:\\s*${required}\\b`).test(operator), `docker-compose.yml is missing the '${required}' service`);
}
console.log("[deploy-consistency] operator compose wires dispatcher + gram-watcher OK");

console.log("[deploy-consistency] ALL OK");
