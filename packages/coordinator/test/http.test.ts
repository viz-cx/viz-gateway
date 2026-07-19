import { test } from "node:test";
import assert from "node:assert/strict";
import { corsHeadersFor, serializeFees, loadAllowedOrigins, resolveStaticPath, contentTypeFor } from "../src/http";
import type { GatewayFeeConfig } from "@gateway/common";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10000n,
  gramFloorMilliViz: 45000n,
  bps: 20,
  activationSurchargeMilliViz: { GRAM: 37500n, SOLANA: 10000n },
  mintGasFloorMilliViz: { GRAM: 1000n, SOLANA: 1000n },
  mintGasTon: 0.06,
  walletDeployGasTon: 0.05,
  margin: 1.5,
  gramVizPerTon: 500,
  refundFeeMilliViz: 5000n,
};

test("corsHeadersFor echoes a listed origin with Vary", () => {
  const h = corsHeadersFor("https://viz-cx.github.io", ["https://viz-cx.github.io"]);
  assert.equal(h["access-control-allow-origin"], "https://viz-cx.github.io");
  assert.equal(h["vary"], "Origin");
});

test("corsHeadersFor returns no header for an unlisted origin", () => {
  assert.deepEqual(corsHeadersFor("https://evil.example", ["https://gateway.viz.cx"]), {});
});

test("corsHeadersFor returns no header when Origin is absent", () => {
  assert.deepEqual(corsHeadersFor(undefined, ["https://gateway.viz.cx"]), {});
});

test("serializeFees emits only whitelisted fields as numbers", () => {
  const out = serializeFees(FEES);
  assert.deepEqual(out, {
    floorMilliViz: { GRAM: 45000, SOLANA: 10000 },
    bps: 20,
    activationSurchargeMilliViz: { GRAM: 37500, SOLANA: 10000 },
    mintGasFloorMilliViz: { GRAM: 1000, SOLANA: 1000 },
    refundFeeMilliViz: 5000,
    decimals: 3,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "margin"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "minVizPerTon"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "gramVizPerTon"), false);
});

test("loadAllowedOrigins parses a JSON string array", () => {
  const dir = mkdtempSync(join(tmpdir(), "origins-"));
  const f = join(dir, "allowed-origins.json");
  writeFileSync(f, JSON.stringify(["https://gateway.viz.cx", "https://viz-cx.github.io"]));
  assert.deepEqual(loadAllowedOrigins(f), ["https://gateway.viz.cx", "https://viz-cx.github.io"]);
});

test("loadAllowedOrigins fails closed on missing file", () => {
  assert.deepEqual(loadAllowedOrigins("/no/such/file.json"), []);
});

test("loadAllowedOrigins fails closed on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "origins-"));
  const f = join(dir, "bad.json");
  writeFileSync(f, "{ not json");
  assert.deepEqual(loadAllowedOrigins(f), []);
});

test("loadAllowedOrigins fails closed when top level is not a string array", () => {
  const dir = mkdtempSync(join(tmpdir(), "origins-"));
  const f = join(dir, "obj.json");
  writeFileSync(f, JSON.stringify({ origins: ["x"] }));
  assert.deepEqual(loadAllowedOrigins(f), []);
});

test("resolveStaticPath maps / to index.html", () => {
  const r = resolveStaticPath("/", "/srv/site");
  assert.deepEqual(r, { absPath: `/srv/site${sep}index.html`, contentType: "text/html; charset=utf-8" });
});

test("resolveStaticPath strips the query string", () => {
  const r = resolveStaticPath("/app.js?v=2", "/srv/site");
  assert.equal((r as { absPath: string }).absPath, `/srv/site${sep}app.js`);
  assert.equal((r as { contentType: string }).contentType, "text/javascript; charset=utf-8");
});

test("resolveStaticPath rejects path traversal", () => {
  assert.deepEqual(resolveStaticPath("/../../etc/passwd", "/srv/site"), { forbidden: true });
});

test("contentTypeFor covers the known extensions", () => {
  assert.equal(contentTypeFor("a.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("a.png"), "image/png");
  assert.equal(contentTypeFor("a.unknown"), "application/octet-stream");
});
