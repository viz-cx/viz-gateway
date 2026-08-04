import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { corsHeadersFor, serializeFees, serializeReconSnapshots } from "../src/http";
import { reconSnapshotKey, serializeReconSnapshot, type GatewayFeeConfig } from "@gateway/common";

const FEES: GatewayFeeConfig = {
  floorMilliViz: 10000n, gramFloorMilliViz: 45000n, bps: 20,
  activationSurchargeMilliViz: { GRAM: 37500n, SOLANA: 10000n },
  mintGasFloorMilliViz: { GRAM: 1000n, SOLANA: 1000n },
  mintGasTon: 0.06, walletDeployGasTon: 0.05, margin: 1.5,
  gramVizPerTon: 500, refundFeeMilliViz: 5000n,
};
const ALLOWED = ["https://viz-cx.github.io"];

/** Fake KV backing the /recon route: one entry per chain, or a thrown read. */
interface ReconSource {
  chains: string[];
  getState: (key: string) => Promise<string | null>;
  paused?: boolean;
}

function withServer(recon?: ReconSource): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const cors = corsHeadersFor(req.headers.origin, ALLOWED);
      if (req.method === "OPTIONS" && (req.url === "/fees" || req.url === "/health" || req.url === "/recon")) {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET" });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/fees") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60", ...cors });
        res.end(JSON.stringify(serializeFees(FEES)));
        return;
      }
      // Mirrors the /recon branch in src/index.ts (same helpers, same headers).
      if (req.method === "GET" && req.url === "/recon" && recon) {
        void Promise.all([
          Promise.resolve(recon.paused ?? false),
          Promise.all(recon.chains.map(async (c) => [c, await recon.getState(reconSnapshotKey(c))] as const)),
        ])
          .then(([paused, entries]) => {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=15", ...cors });
            res.end(JSON.stringify({ ok: true, paused, chains: serializeReconSnapshots(entries) }));
          })
          .catch(() => {
            res.writeHead(503, { "content-type": "application/json", ...cors });
            res.end(JSON.stringify({ ok: false, error: "recon snapshot unavailable" }));
          });
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
    assert.deepEqual(body.floorMilliViz, { GRAM: 45000, SOLANA: 10000 });
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

// --- GET /recon: the public peg-invariant snapshot the landing page renders ---

const GRAM_SNAP = serializeReconSnapshot({
  chain: "GRAM",
  lockedMilliViz: 43_547_500n,
  circulatingMilliViz: 43_500_000n,
  unsweptFeesMilliViz: 0n,
  driftMilliViz: 47_500n,
  status: "OK",
  checkedAt: 1_754_300_000_000,
});

const oneChain = (value: string | null): ReconSource => ({
  chains: ["GRAM"],
  getState: async (key) => (key === reconSnapshotKey("GRAM") ? value : null),
});

test("GET /recon serves the snapshot as mVIZ numbers with a cache header", async () => {
  const s = await withServer(oneChain(GRAM_SNAP));
  try {
    const r = await fetch(`${s.base}/recon`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "max-age=15");
    const body = await r.json() as { ok: boolean; paused: boolean; chains: Record<string, Record<string, unknown>> };
    assert.equal(body.ok, true);
    assert.equal(body.paused, false);
    assert.deepEqual(body.chains["GRAM"], {
      lockedMilliViz: 43547500,
      circulatingMilliViz: 43500000,
      unsweptFeesMilliViz: 0,
      driftMilliViz: 47500,
      status: "OK",
      checkedAt: 1754300000000,
    });
  } finally { s.close(); }
});

test("GET /recon reports the pause flag alongside the figures (one fetch for the card)", async () => {
  const s = await withServer({ ...oneChain(GRAM_SNAP), paused: true });
  try {
    const body = await (await fetch(`${s.base}/recon`)).json() as { paused: boolean };
    assert.equal(body.paused, true);
  } finally { s.close(); }
});

test("GET /recon returns 200 with an empty map before recon's first definitive tick", async () => {
  const s = await withServer(oneChain(null));
  try {
    const r = await fetch(`${s.base}/recon`);
    assert.equal(r.status, 200, "404 would be indistinguishable from a bad deploy");
    const body = await r.json() as { ok: boolean; chains: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.deepEqual(body.chains, {});
  } finally { s.close(); }
});

test("GET /recon omits a chain whose snapshot is corrupt rather than emitting zeros", async () => {
  const s = await withServer(oneChain('{"chain":"GRAM","lockedMilliViz":'));
  try {
    const body = await (await fetch(`${s.base}/recon`)).json() as { chains: Record<string, unknown> };
    assert.deepEqual(body.chains, {});
  } finally { s.close(); }
});

test("GET /recon returns 503 when the store cannot be read", async () => {
  const s = await withServer({ chains: ["GRAM"], getState: async () => { throw new Error("store down"); } });
  try {
    const r = await fetch(`${s.base}/recon`);
    assert.equal(r.status, 503, "an unreadable store must not masquerade as 'no data'");
    const body = await r.json() as { ok: boolean };
    assert.equal(body.ok, false);
  } finally { s.close(); }
});

test("GET /recon exposes only configured chains", async () => {
  const both = serializeReconSnapshot({
    chain: "SOLANA", lockedMilliViz: 1n, circulatingMilliViz: 1n, unsweptFeesMilliViz: 0n,
    driftMilliViz: 0n, status: "OK", checkedAt: 1_754_300_000_000,
  });
  // A SOLANA snapshot exists in the KV, but this deployment configures GRAM only.
  const s = await withServer({
    chains: ["GRAM"],
    getState: async (key) => (key === reconSnapshotKey("GRAM") ? GRAM_SNAP : both),
  });
  try {
    const body = await (await fetch(`${s.base}/recon`)).json() as { chains: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.chains), ["GRAM"]);
  } finally { s.close(); }
});

test("GET /recon echoes a listed origin and withholds it from others", async () => {
  const s = await withServer(oneChain(GRAM_SNAP));
  try {
    const ok = await fetch(`${s.base}/recon`, { headers: { origin: "https://viz-cx.github.io" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://viz-cx.github.io");
    const bad = await fetch(`${s.base}/recon`, { headers: { origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  } finally { s.close(); }
});

test("OPTIONS /recon preflight returns 204", async () => {
  const s = await withServer(oneChain(GRAM_SNAP));
  try {
    const r = await fetch(`${s.base}/recon`, { method: "OPTIONS", headers: { origin: "https://viz-cx.github.io" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-methods"), "GET");
  } finally { s.close(); }
});
