import type { GatewayFeeConfig } from "@gateway/common";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalize, join, extname, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Strict allowlist echo (no wildcard): a listed Origin is reflected back so the
 * browser permits the cross-origin read; anything else gets no ACAO header and
 * is blocked. Same-origin requests carry no Origin and need no header.
 */
export function corsHeadersFor(origin: string | undefined, allowed: string[]): Record<string, string> {
  if (origin && allowed.includes(origin)) {
    return { "access-control-allow-origin": origin, "vary": "Origin" };
  }
  return {};
}

/**
 * Public /fees payload. Whitelisted fields ONLY — never spread the whole config,
 * so growth in GatewayFeeConfig can't leak internal knobs. milliViz values fit
 * safely in a JS number. `decimals` is VIZ's fixed milli precision.
 */
export function serializeFees(fees: GatewayFeeConfig): Record<string, unknown> {
  return {
    floorMilliViz: {
      GRAM: Number(fees.gramFloorMilliViz ?? fees.floorMilliViz),
      SOLANA: Number(fees.floorMilliViz),
    },
    bps: fees.bps,
    activationSurchargeMilliViz: {
      GRAM: Number(fees.activationSurchargeMilliViz.GRAM),
      SOLANA: Number(fees.activationSurchargeMilliViz.SOLANA),
    },
    mintGasFloorMilliViz: {
      GRAM: Number(fees.mintGasFloorMilliViz.GRAM),
      SOLANA: Number(fees.mintGasFloorMilliViz.SOLANA),
    },
    refundFeeMilliViz: Number(fees.refundFeeMilliViz),
    decimals: 3,
  };
}

/** Committed, PR-extensible origin allowlist. Fail closed: bad file → []. */
export function loadAllowedOrigins(filePath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((o) => typeof o === "string")) {
      console.warn(`[coordinator] ${filePath} is not a JSON string array — no cross-origin access`);
      return [];
    }
    return parsed as string[];
  } catch (err) {
    console.warn(`[coordinator] could not load allowlist ${filePath}: ${String(err)} — no cross-origin access`);
    return [];
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Pure path resolution confined to `root`. Traversal → { forbidden: true }. */
export function resolveStaticPath(
  urlPath: string,
  root: string,
): { absPath: string; contentType: string } | { forbidden: true } {
  const rootAbs = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return { forbidden: true }; // malformed percent-encoding
  }
  // normalize() collapses leading `..` at the root, so an explicit segment check
  // is what actually rejects traversal — not the startsWith guard below.
  if (decoded.split("/").some((seg) => seg === "..")) return { forbidden: true };
  const clean = normalize(decoded);
  const rel = clean === "/" || clean === "" ? "index.html" : clean.replace(/^\/+/, "");
  const absPath = join(rootAbs, rel);
  if (absPath !== rootAbs && !absPath.startsWith(rootAbs + sep)) {
    return { forbidden: true }; // defense in depth
  }
  return { absPath, contentType: contentTypeFor(absPath) };
}

/** Serve a file from `root`. 403 on traversal, 404 on miss, else 200. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const r = resolveStaticPath(req.url ?? "/", root);
  if ("forbidden" in r) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(r.absPath);
    const cache = r.contentType.startsWith("text/html") ? "no-cache" : "max-age=300";
    res.writeHead(200, { "content-type": r.contentType, "cache-control": cache });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}
