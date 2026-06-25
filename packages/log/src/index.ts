import { createLogger as createWinston, format, transports, type Logger } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Structured logging for the gateway services. Each service tags its lines with a
 * module name; output goes to the console plus a daily-rotated file. Replaces the
 * ad-hoc `console.log("[svc] …")` calls with levelled, JSON-meta logs.
 *
 * Lives in its own package (winston is a runtime dep) so `@gateway/common` stays
 * dependency-light.
 */

const LOG_DIR = process.env.LOG_DIR ?? "./logs";

function ensureDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* best-effort: fall back to console-only if the dir can't be made */
  }
}

const line = format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
  const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `[${timestamp}] [${String(level).toUpperCase()}] [${mod ?? "-"}]${metaStr} ${message}`;
});

export function createLogger(module: string): Logger {
  ensureDir();
  return createWinston({
    level: process.env.LOG_LEVEL ?? "debug",
    defaultMeta: { module },
    format: format.combine(format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), line),
    transports: [
      new transports.Console(),
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: `${module}-%DATE%.log`,
        datePattern: "YYYY-MM-DD",
        maxSize: "50m",
        maxFiles: "30d",
      }),
    ],
  });
}

const staffLog = createLogger("staff");

/**
 * Operator notification. For now this is just a loud red error log with a scope
 * tag; the interface is ready for a real channel (Telegram, PagerDuty, ...) later
 * without touching call sites. Scopes: "deposits" | "withdraws" | "drift" |
 * "reserve" | "refund".
 */
export function notifyStaff(scope: string, message: string, meta: Record<string, unknown> = {}): void {
  staffLog.error(`[NOTIFY:${scope}] ${message}`, meta);
}
