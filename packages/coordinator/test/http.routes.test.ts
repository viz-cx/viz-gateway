import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { corsHeadersFor, serializeFees } from "../src/http";
import type { GatewayFeeConfig } from "@gateway/common";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10000n, bps: 20,
  activationSurchargeMilliViz: { GRAM: 10000n, SOLANA: 10000n },
  mintGasFloorMilliViz: { GRAM: 1000n, SOLANA: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.1,
  minVizPerTon: 1, maxVizPerTon: 100000, refundFeeMilliViz: 5000n,
};
const ALLOWED = ["https://viz-cx.github.io"];

function withServer(): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const cors = corsHeadersFor(req.headers.origin, ALLOWED);
      if (req.method === "OPTIONS" && (req.url === "/fees" || req.url === "/health")) {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET" });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/fees") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60", ...cors });
        res.end(JSON.stringify(serializeFees(FEES)));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("GET /fees returns serialized fees with cache header", async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/fees`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "max-age=60");
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.floorMilliViz, 10000);
    assert.equal(body.refundFeeMilliViz, 5000);
    assert.equal(body.decimals, 3);
  } finally { s.close(); }
});

test("GET /fees echoes a listed origin", async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/fees`, { headers: { origin: "https://viz-cx.github.io" } });
    assert.equal(r.headers.get("access-control-allow-origin"), "https://viz-cx.github.io");
    assert.equal(r.headers.get("vary"), "Origin");
  } finally { s.close(); }
});

test("GET /fees sends no CORS header for an unlisted origin", async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/fees`, { headers: { origin: "https://evil.example" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally { s.close(); }
});

test("OPTIONS /fees preflight returns 204 with allow-methods", async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/fees`, { method: "OPTIONS", headers: { origin: "https://viz-cx.github.io" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-methods"), "GET");
    assert.equal(r.headers.get("access-control-allow-origin"), "https://viz-cx.github.io");
  } finally { s.close(); }
});
