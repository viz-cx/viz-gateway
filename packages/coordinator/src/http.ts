import { parseReconSnapshot, type GatewayFeeConfig, type ReconSnapshot } from "@gateway/common";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalize, join, extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Is this /submit request authorized? /submit runs the full sign+broadcast orchestration and is
 * reachable on the public proxy, so it MUST only be driven by the dispatcher. The dispatcher sends
 * `Authorization: Bearer <token>` with the shared COORDINATOR_SUBMIT_TOKEN; here we require an exact
 * (constant-time) match.
 *
 * Empty `token` => unauthenticated (the caller warns at boot): allow, so adding the code without
 * yet provisioning the secret does not brick a live deployment. Set the token to actually close
 * the replay/forgery hole. Constant-time compare avoids leaking the token via response timing.
 */
export function isSubmitAuthorized(authHeader: string | undefined, token: string): boolean {
  if (!token) return true; // not configured yet — see the boot warning; hole is open until set
  const presented = /^Bearer (.+)$/.exec(authHeader ?? "")?.[1];
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

/**
 * Public /recon payload: the last DEFINITIVE peg-invariant check per chain, as published
 * by recon into the gateway_state KV. Read-only mirror of figures that are already public
 * on-chain (a VIZ account balance and a Jetton total supply), so nothing here is a leak.
 *
 * `chains` is a map, not an array, so wiring SOLANA later is additive rather than a shape
 * break for the site. A chain with no snapshot yet (fresh boot, or recon has only ever
 * been indeterminate) is simply ABSENT — the consumer must handle an empty map, and must
 * treat freshness as a function of `checkedAt`, not of presence.
 *
 * milliViz values go out as JS numbers, matching serializeFees: VIZ's total supply in
 * mVIZ is ~1e11, far inside the 2^53 exact-integer range.
 */
export function serializeReconSnapshots(
  entries: readonly (readonly [chain: string, kvValue: string | null])[],
): Record<string, unknown> {
  const chains: Record<string, unknown> = {};
  for (const [chain, kvValue] of entries) {
    const snap: ReconSnapshot | null = parseReconSnapshot(kvValue);
    if (!snap) continue; // absent or malformed → omit; never emit a zero-filled row
    chains[chain] = {
      lockedMilliViz: Number(snap.lockedMilliViz),
      circulatingMilliViz: Number(snap.circulatingMilliViz),
      unsweptFeesMilliViz: Number(snap.unsweptFeesMilliViz),
      driftMilliViz: Number(snap.driftMilliViz),
      status: snap.status,
      checkedAt: snap.checkedAt,
    };
  }
  return chains;
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
