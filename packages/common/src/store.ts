import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActionStatus,
  DepositAddressRecord,
  EnqueueInput,
  OutboxRecord,
  OutboxRemoteChain,
  StatusPatch,
} from "./idempotency";

/**
 * Persistent, cross-process gateway state:
 *   - the durable `action_outbox` (idempotency ledger + delivery queue),
 *   - the rolling 24h cap window (shared across processes; survives restart),
 *   - the global pause flag.
 * All services open the SAME SQLite file (shared volume in Docker), so a pause
 * tripped by recon is seen by every other process and the cap window is global.
 *
 * Pause semantics: tripping is 1-of-N (any process may pause); clearing is a
 * deliberate operator action (unpause()), gated behind T-of-N by the coordinator.
 */
export interface GatewayStore {
  // --- outbox (durable action ledger + delivery queue) ---
  /** Atomically first-claim + persist an action. Returns true iff newly inserted. */
  enqueue(input: EnqueueInput): Promise<boolean>;
  get(id: string): Promise<OutboxRecord | undefined>;
  /** Advance status (+ optional attempts/error/txid/nextAttemptAt/feeMilliViz). */
  setStatus(id: string, status: ActionStatus, patch?: StatusPatch): Promise<void>;
  /** Remove a row entirely (used to release an unfulfilled first-claim for retry). */
  delete(id: string): Promise<void>;
  /** Rows in any of `statuses` whose nextAttemptAt <= now (dispatcher work list). */
  due(now: number, statuses: ActionStatus[]): Promise<OutboxRecord[]>;
  /** Rows stuck in a non-terminal `statuses` longer than ageMs (stale alert). */
  stale(now: number, ageMs: number, statuses: ActionStatus[]): Promise<OutboxRecord[]>;
  /**
   * VIZ fees minted-as-surplus but not yet swept to fees.gate, in milli-VIZ.
   * = sum(PEG_IN fee, minted) − sum(FEE_SWEEP amount, confirmed). recon adds this
   * to circulating to keep `locked == circulating + unswept` exact between sweeps.
   */
  unsweptFeesMilliViz(): Promise<bigint>;

  // --- rolling 24h cap window (shared) ---
  recordCap(amountMilliViz: bigint, now: number): Promise<void>;
  capSumMilliViz(sinceMs: number, now: number): Promise<bigint>;

  // --- peg-out deposit addresses (Variant A registry) ---
  /** Register (idempotently) a derived deposit address for a VIZ account. */
  registerDepositAddress(rec: { vizAccount: string; solAddress: string; wvizAta: string }): Promise<void>;
  /** Look up the mapping by owner address OR wVIZ ATA (scanner -> release target). */
  depositAddressBy(addressOrAta: string): Promise<DepositAddressRecord | undefined>;
  /** Addresses to scan, oldest-scanned first (priority desc), capped at `limit`. */
  depositAddressesForScan(limit: number): Promise<DepositAddressRecord[]>;
  /** Stamp scan_time after scanning a VIZ account's address. */
  touchDepositScan(vizAccount: string, now: number): Promise<void>;

  // --- global pause ---
  isPaused(): Promise<boolean>;
  pause(reason: string): Promise<void>;
  unpause(): Promise<void>;
  pauseReason(): Promise<string | null>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;

/** PEG_IN statuses at/after which the fee has been minted-as-surplus. */
const MINTED_STATUSES: ActionStatus[] = ["BROADCAST", "CONFIRMED"];

function rowToRecord(r: Row): OutboxRecord {
  const remote = r["remote_chain"] as string | null;
  return {
    id: String(r["id"]),
    direction: r["direction"] as OutboxRecord["direction"],
    remoteChain: remote ? (remote as OutboxRemoteChain) : undefined,
    recipient: String(r["recipient"]),
    sender: (r["sender"] as string | null) ?? null,
    amountMilliViz: BigInt(String(r["amount_milli_viz"])),
    feeMilliViz: BigInt(String(r["fee_milli_viz"])),
    digest: String(r["digest"]),
    status: r["status"] as ActionStatus,
    attempts: Number(r["attempts"]),
    lastError: (r["last_error"] as string | null) ?? null,
    txid: (r["txid"] as string | null) ?? null,
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
    nextAttemptAt: Number(r["next_attempt_at"]),
    parentId: (r["parent_id"] as string | null) ?? null,
  };
}

export class SqliteGatewayStore implements GatewayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL;
       PRAGMA busy_timeout=5000;
       CREATE TABLE IF NOT EXISTS action_outbox(
         id               TEXT PRIMARY KEY,
         direction        TEXT NOT NULL,
         remote_chain     TEXT,
         recipient        TEXT NOT NULL,
         sender           TEXT,
         amount_milli_viz TEXT NOT NULL,
         fee_milli_viz    TEXT NOT NULL DEFAULT '0',
         digest           TEXT NOT NULL,
         status           TEXT NOT NULL,
         attempts         INTEGER NOT NULL DEFAULT 0,
         last_error       TEXT,
         txid             TEXT,
         created_at       INTEGER NOT NULL,
         updated_at       INTEGER NOT NULL,
         next_attempt_at  INTEGER NOT NULL DEFAULT 0,
         parent_id        TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_outbox_status ON action_outbox(status, next_attempt_at);
       CREATE TABLE IF NOT EXISTS cap_window(
         ts               INTEGER NOT NULL,
         amount_milli_viz TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_cap_ts ON cap_window(ts);
       CREATE TABLE IF NOT EXISTS deposit_addresses(
         viz_account TEXT PRIMARY KEY,
         sol_address TEXT NOT NULL,
         wviz_ata    TEXT NOT NULL,
         created_at  INTEGER NOT NULL,
         scan_time   INTEGER NOT NULL DEFAULT 0,
         priority    INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS idx_dep_scan ON deposit_addresses(priority DESC, scan_time ASC);
       CREATE INDEX IF NOT EXISTS idx_dep_addr ON deposit_addresses(sol_address);
       CREATE INDEX IF NOT EXISTS idx_dep_ata ON deposit_addresses(wviz_ata);
       CREATE TABLE IF NOT EXISTS gateway_state(
         key TEXT PRIMARY KEY,
         value TEXT,
         updated_at INTEGER NOT NULL
       );`,
    );
    // Migration: add parent_id if the table predates this column.
    const cols = this.db.prepare("PRAGMA table_info(action_outbox)").all() as Row[];
    if (!cols.some((c) => c["name"] === "parent_id")) {
      this.db.exec("ALTER TABLE action_outbox ADD COLUMN parent_id TEXT");
    }
  }

  async registerDepositAddress(rec: { vizAccount: string; solAddress: string; wvizAta: string }): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO deposit_addresses(viz_account, sol_address, wviz_ata, created_at)
         VALUES(?, ?, ?, ?)`,
      )
      .run(rec.vizAccount, rec.solAddress, rec.wvizAta, Date.now());
  }

  async depositAddressBy(addressOrAta: string): Promise<DepositAddressRecord | undefined> {
    const r = this.db
      .prepare("SELECT * FROM deposit_addresses WHERE sol_address = ? OR wviz_ata = ?")
      .get(addressOrAta, addressOrAta) as Row | undefined;
    if (!r) return undefined;
    return {
      vizAccount: String(r["viz_account"]),
      solAddress: String(r["sol_address"]),
      wvizAta: String(r["wviz_ata"]),
      createdAt: Number(r["created_at"]),
      scanTime: Number(r["scan_time"]),
      priority: Number(r["priority"]),
    };
  }

  async depositAddressesForScan(limit: number): Promise<DepositAddressRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM deposit_addresses ORDER BY priority DESC, scan_time ASC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => ({
      vizAccount: String(r["viz_account"]),
      solAddress: String(r["sol_address"]),
      wvizAta: String(r["wviz_ata"]),
      createdAt: Number(r["created_at"]),
      scanTime: Number(r["scan_time"]),
      priority: Number(r["priority"]),
    }));
  }

  async touchDepositScan(vizAccount: string, now: number): Promise<void> {
    this.db.prepare("UPDATE deposit_addresses SET scan_time = ? WHERE viz_account = ?").run(now, vizAccount);
  }

  async enqueue(input: EnqueueInput): Promise<boolean> {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO action_outbox(
           id, direction, remote_chain, recipient, sender, amount_milli_viz, fee_milli_viz,
           digest, status, attempts, last_error, txid, created_at, updated_at, next_attempt_at, parent_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, 0, ?)`,
      )
      .run(
        input.id,
        input.direction,
        input.remoteChain ?? null,
        input.recipient,
        input.sender ?? null,
        input.amountMilliViz.toString(),
        (input.feeMilliViz ?? 0n).toString(),
        input.digest,
        input.status ?? "SEEN",
        now,
        now,
        input.parentId ?? null,
      );
    return Number(res.changes) === 1;
  }

  async get(id: string): Promise<OutboxRecord | undefined> {
    const r = this.db.prepare("SELECT * FROM action_outbox WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToRecord(r) : undefined;
  }

  async setStatus(id: string, status: ActionStatus, patch: StatusPatch = {}): Promise<void> {
    // COALESCE keeps the existing column when the patch field is undefined.
    this.db
      .prepare(
        `UPDATE action_outbox SET
           status = ?,
           attempts = COALESCE(?, attempts),
           last_error = CASE WHEN ?=1 THEN ? ELSE last_error END,
           txid = CASE WHEN ?=1 THEN ? ELSE txid END,
           fee_milli_viz = COALESCE(?, fee_milli_viz),
           next_attempt_at = COALESCE(?, next_attempt_at),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.attempts ?? null,
        patch.lastError !== undefined ? 1 : 0,
        patch.lastError ?? null,
        patch.txid !== undefined ? 1 : 0,
        patch.txid ?? null,
        patch.feeMilliViz !== undefined ? patch.feeMilliViz.toString() : null,
        patch.nextAttemptAt ?? null,
        Date.now(),
        id,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM action_outbox WHERE id = ?").run(id);
  }

  async due(now: number, statuses: ActionStatus[]): Promise<OutboxRecord[]> {
    if (statuses.length === 0) return [];
    const ph = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM action_outbox
         WHERE status IN (${ph}) AND next_attempt_at <= ?
         ORDER BY created_at ASC`,
      )
      .all(...statuses, now) as Row[];
    return rows.map(rowToRecord);
  }

  async stale(now: number, ageMs: number, statuses: ActionStatus[]): Promise<OutboxRecord[]> {
    if (statuses.length === 0) return [];
    const ph = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM action_outbox WHERE status IN (${ph}) AND updated_at < ?`)
      .all(...statuses, now - ageMs) as Row[];
    return rows.map(rowToRecord);
  }

  async unsweptFeesMilliViz(): Promise<bigint> {
    const ph = MINTED_STATUSES.map(() => "?").join(",");
    const minted = this.db
      .prepare(
        `SELECT COALESCE(SUM(CAST(fee_milli_viz AS INTEGER)), 0) AS s
         FROM action_outbox WHERE direction='PEG_IN' AND status IN (${ph})`,
      )
      .get(...MINTED_STATUSES) as Row;
    const swept = this.db
      .prepare(
        `SELECT COALESCE(SUM(CAST(amount_milli_viz AS INTEGER)), 0) AS s
         FROM action_outbox WHERE direction='FEE_SWEEP' AND status='CONFIRMED'`,
      )
      .get() as Row;
    const v = BigInt(String(minted["s"])) - BigInt(String(swept["s"]));
    return v > 0n ? v : 0n;
  }

  async recordCap(amountMilliViz: bigint, now: number): Promise<void> {
    this.db
      .prepare("INSERT INTO cap_window(ts, amount_milli_viz) VALUES(?, ?)")
      .run(now, amountMilliViz.toString());
  }

  async capSumMilliViz(sinceMs: number, now: number): Promise<bigint> {
    // Prune expired entries, then sum the live window.
    this.db.prepare("DELETE FROM cap_window WHERE ts < ?").run(sinceMs);
    const r = this.db
      .prepare("SELECT COALESCE(SUM(CAST(amount_milli_viz AS INTEGER)), 0) AS s FROM cap_window WHERE ts <= ?")
      .get(now) as Row;
    return BigInt(String(r["s"]));
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
  private readonly rows = new Map<string, OutboxRecord>();
  private readonly caps: Array<{ ts: number; amount: bigint }> = [];
  private readonly deposits = new Map<string, DepositAddressRecord>();
  private paused = false;
  private reason = "";

  async enqueue(input: EnqueueInput): Promise<boolean> {
    if (this.rows.has(input.id)) return false;
    const now = Date.now();
    this.rows.set(input.id, {
      id: input.id,
      direction: input.direction,
      remoteChain: input.remoteChain,
      recipient: input.recipient,
      sender: input.sender ?? null,
      amountMilliViz: input.amountMilliViz,
      feeMilliViz: input.feeMilliViz ?? 0n,
      digest: input.digest,
      status: input.status ?? "SEEN",
      attempts: 0,
      lastError: null,
      txid: null,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: 0,
      parentId: input.parentId ?? null,
    });
    return true;
  }
  async get(id: string): Promise<OutboxRecord | undefined> {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }
  async setStatus(id: string, status: ActionStatus, patch: StatusPatch = {}): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    r.status = status;
    if (patch.attempts !== undefined) r.attempts = patch.attempts;
    if (patch.lastError !== undefined) r.lastError = patch.lastError;
    if (patch.txid !== undefined) r.txid = patch.txid;
    if (patch.feeMilliViz !== undefined) r.feeMilliViz = patch.feeMilliViz;
    if (patch.nextAttemptAt !== undefined) r.nextAttemptAt = patch.nextAttemptAt;
    r.updatedAt = Date.now();
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async due(now: number, statuses: ActionStatus[]): Promise<OutboxRecord[]> {
    const set = new Set(statuses);
    return [...this.rows.values()]
      .filter((r) => set.has(r.status) && r.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }
  async stale(now: number, ageMs: number, statuses: ActionStatus[]): Promise<OutboxRecord[]> {
    const set = new Set(statuses);
    return [...this.rows.values()].filter((r) => set.has(r.status) && r.updatedAt < now - ageMs).map((r) => ({ ...r }));
  }
  async unsweptFeesMilliViz(): Promise<bigint> {
    let minted = 0n;
    let swept = 0n;
    for (const r of this.rows.values()) {
      if (r.direction === "PEG_IN" && (r.status === "BROADCAST" || r.status === "CONFIRMED")) minted += r.feeMilliViz;
      if (r.direction === "FEE_SWEEP" && r.status === "CONFIRMED") swept += r.amountMilliViz;
    }
    const v = minted - swept;
    return v > 0n ? v : 0n;
  }
  async recordCap(amountMilliViz: bigint, now: number): Promise<void> {
    this.caps.push({ ts: now, amount: amountMilliViz });
  }
  async capSumMilliViz(sinceMs: number, now: number): Promise<bigint> {
    return this.caps.filter((e) => e.ts >= sinceMs && e.ts <= now).reduce((a, e) => a + e.amount, 0n);
  }
  async registerDepositAddress(rec: { vizAccount: string; solAddress: string; wvizAta: string }): Promise<void> {
    if (this.deposits.has(rec.vizAccount)) return;
    this.deposits.set(rec.vizAccount, { ...rec, createdAt: Date.now(), scanTime: 0, priority: 0 });
  }
  async depositAddressBy(addressOrAta: string): Promise<DepositAddressRecord | undefined> {
    for (const d of this.deposits.values()) {
      if (d.solAddress === addressOrAta || d.wvizAta === addressOrAta) return { ...d };
    }
    return undefined;
  }
  async depositAddressesForScan(limit: number): Promise<DepositAddressRecord[]> {
    return [...this.deposits.values()]
      .sort((a, b) => b.priority - a.priority || a.scanTime - b.scanTime)
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  async touchDepositScan(vizAccount: string, now: number): Promise<void> {
    const d = this.deposits.get(vizAccount);
    if (d) d.scanTime = now;
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
