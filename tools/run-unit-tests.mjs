#!/usr/bin/env node
// Portable runner for the node:test unit tier (issue #39, nits 1 & 2).
//
// Why not a shell glob: `node --test dist-test/packages/*/test/*.test.js` false-greens
// on zero matches — POSIX sh (dash on CI) has no failglob/nullglob, so an unexpanded
// literal path is passed to `node --test`, which exits 0 (`# pass 0`). If tsconfig.test.json
// ever stops emitting matching files (rename/move/outDir change) the whole tier silently
// becomes a no-op while CI stays green. It was also single-level, so a test in a subdir of
// test/ compiled but never ran (glob depth mismatch vs the recursive tsconfig include).
//
// This runner discovers files RECURSIVELY (matching tsconfig.test.json's test/**) and FAILS
// LOUDLY on zero matches, then execs `node --test` with the explicit file list.
import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PATTERN = "dist-test/packages/*/test/**/*.test.js";
const files = globSync(PATTERN).sort();

if (files.length === 0) {
  console.error(
    `[test:unit] no test files matched '${PATTERN}'. ` +
      `Did tsconfig.test.json stop emitting to dist-test/ (rename/move/outDir change)? ` +
      `Refusing to pass a no-op test tier.`,
  );
  process.exit(1);
}

console.log(`[test:unit] running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${f}`);

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (res.error) {
  console.error("[test:unit] failed to launch node --test:", res.error);
  process.exit(1);
}
process.exit(res.status ?? 1);
