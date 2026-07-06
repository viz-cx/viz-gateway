import type { IncomingMessage } from "node:http";

/**
 * Bounded HTTP request-body reader (VG BM4).
 *
 * The coordinator /submit and signer /approve handlers accumulated `body += chunk` with no
 * size cap, no timeout, and no "error"/"aborted" handler. A multi-GB body OOMs the process;
 * a half-open request pins the socket forever. readLimitedBody caps the byte count (413) and
 * bounds the read with a timeout (408), destroying the socket on either — so a hostile or
 * broken client can't wedge or exhaust a keyless gateway service.
 */

export class BodyError extends Error {
  constructor(
    message: string,
    /** HTTP status the caller should return for this failure. */
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

export interface ReadBodyOpts {
  /** Max body size in bytes before a 413. Defaults to HTTP_MAX_BODY_BYTES or 1 MiB. */
  maxBytes?: number;
  /** Whole-body read deadline in ms before a 408. Defaults to HTTP_REQUEST_TIMEOUT_MS or 15s. */
  timeoutMs?: number;
}

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export function readLimitedBody(req: IncomingMessage, opts: ReadBodyOpts = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? envInt("HTTP_MAX_BODY_BYTES", 1_048_576);
  const timeoutMs = opts.timeoutMs ?? envInt("HTTP_REQUEST_TIMEOUT_MS", 15_000);

  return new Promise<string>((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;

    const settle = (err?: BodyError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(body);
    };

    const timer = setTimeout(() => {
      req.destroy();
      settle(new BodyError("request body read timed out", 408));
    }, timeoutMs);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length; // bytes, not UTF-16 units — the real wire cost
      if (size > maxBytes) {
        req.destroy();
        settle(new BodyError(`request body exceeds ${maxBytes} bytes`, 413));
        return;
      }
      body += chunk;
    });
    req.on("end", () => settle());
    req.on("error", (e) => settle(new BodyError(`request stream error: ${String(e)}`, 400)));
    req.on("aborted", () => settle(new BodyError("request aborted by client", 400)));
  });
}
