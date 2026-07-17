import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../src/http";

function withServer(root: string): Promise<{ base: string; close: () => void }> {
  return new Promise((res) => {
    const server = createServer((req, r) => void serveStatic(req, r, root));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("serveStatic serves index.html at /", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-"));
  writeFileSync(join(dir, "index.html"), "<h1>wVIZ</h1>");
  const s = await withServer(dir);
  try {
    const r = await fetch(`${s.base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await r.text(), "<h1>wVIZ</h1>");
  } finally { s.close(); }
});

test("serveStatic 404s an unknown path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-"));
  writeFileSync(join(dir, "index.html"), "x");
  const s = await withServer(dir);
  try {
    assert.equal((await fetch(`${s.base}/missing.js`)).status, 404);
  } finally { s.close(); }
});

test("serveStatic 403s a traversal attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-"));
  writeFileSync(join(dir, "index.html"), "x");
  const s = await withServer(dir);
  try {
    assert.equal((await fetch(`${s.base}/..%2f..%2fetc%2fpasswd`)).status, 403);
  } finally { s.close(); }
});
