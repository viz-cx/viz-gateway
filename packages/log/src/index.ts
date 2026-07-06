import { createLogger as createWinston, format, transports, type Logger } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { mkdirSync, accessSync, constants } from "node:fs";

/**
 * Structured logging for the gateway services. Each service tags its lines with a
 * module name; output goes to the console plus a daily-rotated file. Replaces the
 * ad-hoc `console.log("[svc] …")` calls with levelled, JSON-meta logs.
 *
 * Lives in its own package (winston is a runtime dep) so `@gateway/common` stays
 * dependency-light.
 */

const LOG_DIR = process.env.LOG_DIR ?? "./logs";

let warnedNoFileLog = false;

/**
 * Return LOG_DIR if it is usable for the rotating file transport, else null (→ console-only).
 * The previous version swallowed a failed mkdir but STILL added the DailyRotateFile transport,
 * whose own internal mkdir then threw UNCAUGHT and crashed every service on startup — e.g. a
 * non-root container ($LOG_DIR unwritable, "EACCES mkdir 'logs/'"). We must decide up front and
 * only attach the file transport when the directory is actually writable. mkdir(recursive) is a
 * no-op on an existing dir (so it can't prove writability alone) — hence the explicit W_OK check.
 */
function usableLogDir(): string | null {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    accessSync(LOG_DIR, constants.W_OK);
    return LOG_DIR;
  } catch {
    if (!warnedNoFileLog) {
      warnedNoFileLog = true;
      console.warn(`[log] LOG_DIR '${LOG_DIR}' is not writable — logging to console only. Set LOG_DIR to a writable path for rotated files.`);
    }
    return null;
  }
}

const line = format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
  const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `[${timestamp}] [${String(level).toUpperCase()}] [${mod ?? "-"}]${metaStr} ${message}`;
});

export function createLogger(module: string): Logger {
  const dir = usableLogDir();
  const console = new transports.Console();
  // Only attach the rotating file transport when the dir is writable; otherwise its own internal
  // mkdir throws uncaught and crashes the service on startup (see usableLogDir).
  const file = dir
    ? new DailyRotateFile({
        dirname: dir,
        filename: `${module}-%DATE%.log`,
        datePattern: "YYYY-MM-DD",
        maxSize: "50m",
        maxFiles: "30d",
      })
    : null;
  return createWinston({
    level: process.env.LOG_LEVEL ?? "debug",
    defaultMeta: { module },
    format: format.combine(format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), line),
    transports: file ? [console, file] : [console],
  });
}

const staffLog = createLogger("staff");

// --- Operator alerting (VG BH4) ---------------------------------------------
// notifyStaff was a red log line in a file nobody tails. Every fail-closed pause
// (cap breach, scan truncation, wedged delivery, drift) routes through it, so a
// silent channel means the bridge halts and no operator ever learns. Now it ALSO
// pushes to a real webhook when STAFF_WEBHOOK_URL is set, with bounded retries, and
// flags alerting as UNHEALTHY (surfaced via isAlertingHealthy) when delivery fails —
// so a /health probe or the recon loop can escalate a blind alerting pipe.

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** False once a webhook delivery has exhausted its retries; re-armed by the next success. */
let alertingHealthy = true;
let warnedNoChannel = false;

/** Alerting-pipe health. A service can expose this on /health so a blind alert channel
 * (webhook configured but unreachable) is itself an alertable, visible condition. */
export function isAlertingHealthy(): boolean {
  return alertingHealthy;
}

/** Test seam: reset the module health flags between cases. */
export function __resetAlertingHealthForTest(): void {
  alertingHealthy = true;
  warnedNoChannel = false;
}

export interface StaffWebhookOpts {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a staff alert as JSON to `url`, retrying on network error / non-2xx up to `retries`
 * extra attempts. Each attempt is bounded by an AbortSignal timeout so a blackhole endpoint
 * cannot hang the caller. Returns true on the first delivered attempt, false if all fail.
 */
export async function deliverStaffWebhook(
  url: string,
  scope: string,
  message: string,
  meta: Record<string, unknown> = {},
  opts: StaffWebhookOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? envInt("STAFF_WEBHOOK_TIMEOUT_MS", 10000);
  const retries = opts.retries ?? envInt("STAFF_WEBHOOK_RETRIES", 3);
  const retryDelayMs = opts.retryDelayMs ?? envInt("STAFF_WEBHOOK_RETRY_DELAY_MS", 500);
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ scope, message, meta, ts: Math.floor(Date.now() / 1000) });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
    } catch {
      /* network error / timeout / abort — fall through to retry */
    }
    if (attempt < retries) await sleep(retryDelayMs);
  }
  return false;
}

/**
 * Operator notification. Always writes the loud audit line (console + daily file); when
 * STAFF_WEBHOOK_URL is configured it ALSO fires the webhook (fire-and-forget so call sites
 * stay synchronous). A delivery that exhausts its retries flips isAlertingHealthy() to false
 * and logs a CRITICAL meta-alert; the next success re-arms it. With no webhook configured, it
 * warns ONCE that alerts are file-only (a prod custody bridge must set a channel).
 * Scopes: "deposits" | "withdraws" | "drift" | "reserve" | "refund" | "delivery" | "rotation".
 */
export function notifyStaff(scope: string, message: string, meta: Record<string, unknown> = {}): void {
  staffLog.error(`[NOTIFY:${scope}] ${message}`, meta);
  const url = process.env.STAFF_WEBHOOK_URL;
  if (!url) {
    if (!warnedNoChannel) {
      warnedNoChannel = true;
      staffLog.error(
        "[NOTIFY:alerting] STAFF_WEBHOOK_URL is not set — operator alerts are file-only. Set it so fail-closed pauses reach an on-call channel.",
      );
    }
    return;
  }
  void deliverStaffWebhook(url, scope, message, meta).then((ok) => {
    if (ok) {
      alertingHealthy = true;
    } else {
      alertingHealthy = false;
      staffLog.error("[NOTIFY:alerting] FAILED to deliver staff alert after retries; alerting pipe is DEGRADED", {
        scope,
        message,
      });
    }
  });
}
