import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionState, IdempotencyStore, LedgerRecord } from "./idempotency";

/**
 * Persistent, cross-process gateway state: the idempotency ledger plus the
 * shared global pause flag. All services (watchers, signer, recon) open the
 * SAME SQLite file (mounted on a shared volume in Docker), so a pause tripped
 * by recon is seen by every other process.
 *
 * Pause semantics: tripping the pause is 1-of-N (any process / operator may
 * pause); clearing it is a deliberate operator action (unpause()), which the
 * coordinator should gate behind T-of-N approval.
 */
export interface GatewayStore extends IdempotencyStore {
  isPaused(): Promise<boolean>;
  pause(reason: string): Promise<void>;
  unpause(): Promise<void>;
  pauseReason(): Promise<string | null>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;

export class SqliteGatewayStore implements GatewayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL;
       PRAGMA busy_timeout=5000;
       CREATE TABLE IF NOT EXISTS processed_actions(
         id TEXT PRIMARY KEY,
         state TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS gateway_state(
         key TEXT PRIMARY KEY,
         value TEXT,
         updated_at INTEGER NOT NULL
       );`,
    );
  }

  async get(id: string): Promise<LedgerRecord | undefined> {
    const r = this.db
      .prepare("SELECT id, state, updated_at FROM processed_actions WHERE id = ?")
      .get(id) as Row | undefined;
    if (!r) return undefined;
    return { id: String(r["id"]), state: r["state"] as ActionState, updatedAt: Number(r["updated_at"]) };
  }

  async claim(id: string): Promise<boolean> {
    // Atomic first-claim: INSERT OR IGNORE reports changes=1 only for the
    // process that actually inserted the row.
    const res = this.db
      .prepare("INSERT OR IGNORE INTO processed_actions(id, state, updated_at) VALUES(?, 'SEEN', ?)")
      .run(id, Date.now());
    return Number(res.changes) === 1;
  }

  async setState(id: string, state: ActionState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO processed_actions(id, state, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(id, state, Date.now());
  }

  private setKey(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO gateway_state(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  private getKey(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM gateway_state WHERE key = ?").get(key) as Row | undefined;
    return r ? (r["value"] as string | null) : null;
  }

  async isPaused(): Promise<boolean> {
    return this.getKey("paused") === "1";
  }

  async pause(reason: string): Promise<void> {
    this.setKey("paused", "1");
    this.setKey("pause_reason", reason);
  }

  async unpause(): Promise<void> {
    this.setKey("paused", "0");
    this.setKey("pause_reason", "");
  }

  async pauseReason(): Promise<string | null> {
    return this.getKey("pause_reason");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** In-memory GatewayStore for tests (no persistence, no cross-process sharing). */
export class InMemoryGatewayStore implements GatewayStore {
  private readonly actions = new Map<string, LedgerRecord>();
  private paused = false;
  private reason = "";

  async get(id: string): Promise<LedgerRecord | undefined> {
    return this.actions.get(id);
  }
  async claim(id: string): Promise<boolean> {
    if (this.actions.has(id)) return false;
    this.actions.set(id, { id, state: "SEEN", updatedAt: Date.now() });
    return true;
  }
  async setState(id: string, state: ActionState): Promise<void> {
    this.actions.set(id, { id, state, updatedAt: Date.now() });
  }
  async isPaused(): Promise<boolean> {
    return this.paused;
  }
  async pause(reason: string): Promise<void> {
    this.paused = true;
    this.reason = reason;
  }
  async unpause(): Promise<void> {
    this.paused = false;
    this.reason = "";
  }
  async pauseReason(): Promise<string | null> {
    return this.reason || null;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/**
 * Build a GatewayStore from a STORE_URL.
 *   sqlite:./data/gateway.sqlite   -> file-backed (shared across processes)
 *   sqlite::memory:                -> in-process SQLite (tests)
 *   memory:                        -> InMemoryGatewayStore (tests)
 */
export function createStore(url: string): GatewayStore {
  if (url === "memory:") return new InMemoryGatewayStore();
  if (url.startsWith("sqlite:")) {
    const path = url.slice("sqlite:".length) || ":memory:";
    return new SqliteGatewayStore(path);
  }
  throw new Error(
    `Unsupported STORE_URL '${url}'. Implemented: sqlite:<path>, sqlite::memory:, memory:. ` +
      `Postgres (for HA) is a future driver.`,
  );
}
