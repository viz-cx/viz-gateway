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
import type { RemoteChainId } from "./types";

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
  /**
   * Persist ONLY the withheld PEG_IN fee (no status change). The coordinator calls
   * this the moment it builds the proposal, so the fee is durable even if its
   * response never reaches the dispatcher (lost/crash) or an already-executed action
   * takes the recovery path — otherwise the FEE_SWEEP is skipped and the withheld
   * fee strands as permanent surplus (accounting drift).
   */
  setFee(id: string, feeMilliViz: bigint): Promise<void>;
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
   *
   * SIGNED: a NEGATIVE result (swept > minted fees) is an over-sweep anomaly — mis-pinning
   * or a double FEE_SWEEP leaking backing — NOT clamped to 0 (which would hide it). recon
   * must treat < 0 as a fail-closed condition (pause + alert), never as "0 = fine" (M10).
   */
  unsweptFeesMilliViz(chain?: RemoteChainId): Promise<bigint>;
  /**
   * Smallest pinned fee_milli_viz among minted (BROADCAST/CONFIRMED) PEG_IN rows for the
   * chain, or null if none. Recon asserts this stays ≥ the absolute mint-gas floor — a
   * rate-independent sanity check that catches a grossly under-pinned fee without
   * re-deriving from (and thus coupling to) the current fee config.
   *
   * A BROADCAST row with fee 0 is EXCLUDED: 0 there means the fee is not yet pinned — the
   * dispatcher marks BROADCAST *before* the coordinator call, so recon's tick can land in
   * that in-flight window and would otherwise false-trip the guard. A CONFIRMED row is NOT
   * excluded even at fee 0: the coordinator pins the fee via setFee *before* broadcast and
   * the CONFIRMED transition COALESCEs (never clobbering it), so a CONFIRMED row always
   * carries its positive fee. A fee 0 there is a genuine mis-pin / a coordinator understating
   * the fee to mask under-backing (H6) and MUST fail closed. A genuine under-pin is likewise
   * a small *positive* value, still caught.
   */
  minPegInFeeMilliViz(chain?: RemoteChainId): Promise<bigint | null>;
  /**
   * Distinct remote chains that have minted (or committed to minting) wVIZ — any chain with a
   * PEG_IN row past the caps gate (QUEUED/SIGNING/BROADCAST/CONFIRMED). Such a chain has live or
   * imminent circulating wVIZ, so recon MUST run a per-chain check for it. Derived from the outbox
   * itself, NOT from env config, so a chain that drops out of RECON_EXPECTED_REMOTES (which defaults
   * empty → fail-open) is still forced back into recon: dropping a live remote's config would
   * otherwise silently stop checking its backing (per-chain fail-open, M9).
   */
  activeRemoteChains(): Promise<RemoteChainId[]>;

  // --- rolling 24h cap window (shared) ---
  recordCap(amountMilliViz: bigint, now: number): Promise<void>;
  capSumMilliViz(sinceMs: number, now: number): Promise<bigint>;
  /**
   * Atomic reserve: prune, sum the live window, and record `amountMilliViz` ONLY if the
   * post-record total stays within `capMilliViz` — all in one transaction. Returns true if
   * reserved, false if it would breach the cap (nothing recorded). Closes the cross-process
   * TOCTOU where two watchers both read the sum, both pass, then both record over the cap.
   */
  tryReserveCap(amountMilliViz: bigint, capMilliViz: bigint, sinceMs: number, now: number): Promise<boolean>;

  // --- peg-out deposit addresses (Variant A registry) ---
  /** Register (idempotently) a derived deposit address for a VIZ account. */
  registerDepositAddress(rec: { vizAccount: string; solAddress: string; wvizAta: string }): Promise<void>;
  /** Look up the mapping by owner address OR wVIZ ATA (scanner -> release target). */
  depositAddressBy(addressOrAta: string): Promise<DepositAddressRecord | undefined>;
  /** Addresses to scan, oldest-scanned first (priority desc), capped at `limit`. */
  depositAddressesForScan(limit: number): Promise<DepositAddressRecord[]>;
  /** Stamp scan_time after scanning a VIZ account's address. */
  touchDepositScan(vizAccount: string, now: number): Promise<void>;

  // --- durable scan cursors (watcher restart-safety) ---
  /**
   * A named, persisted scan cursor (survives restart). Watchers resume from here
   * so downtime never silently skips unseen work. Returns 0 if unset.
   */
  getCursor(name: string): Promise<number>;
  /**
   * Advance a scan cursor. Monotonic: a write that would move the cursor backward
   * is ignored (guards against a racing/stale writer re-scanning old ground).
   */
  setCursor(name: string, value: number): Promise<void>;

  // --- global pause ---
  isPaused(): Promise<boolean>;
  pause(reason: string): Promise<void>;
  unpause(): Promise<void>;
  pauseReason(): Promise<string | null>;
  close(): Promise<void>;

  // --- generic gateway_state KV (last-good fee quotes, etc.) ---
  /** Read a gateway_state KV entry; returns null if unset. */
  getState(key: string): Promise<string | null>;
  /** Write a gateway_state KV entry. */
  setState(key: string, value: string): Promise<void>;

  // --- per-source peg-in rate limit ---
  /**
   * Atomic sliding-window rate check. Prunes entries older than `now − windowMs`,
   * counts live entries for this sender, records + returns true iff count < maxPerWindow.
   * Returns false (without recording) when the limit is already reached.
   */
  tryReserveSenderRate(sender: string, maxPerWindow: number, windowMs: number, now: number): Promise<boolean>;
}

type Row = Record<string, unknown>;

/** PEG_IN statuses at/after which the fee has been minted-as-surplus. */
const MINTED_STATUSES: ActionStatus[] = ["BROADCAST", "CONFIRMED"];

/**
 * PEG_IN statuses at/after which a wVIZ mint is COMMITTED: it has passed the caps gate (QUEUED)
 * and will mint barring a crash, or already has. A chain with any such row has live-or-imminent
 * circulating wVIZ and must never leave recon (M9). Broader than MINTED_STATUSES so the
 * QUEUED→BROADCAST window can't briefly mint on a chain recon doesn't yet cover. Refunded/held
 * rows (SEEN/HELD/REFUNDING/REFUNDED/FAILED) never mint, so they don't mark a chain active.
 */
const ACTIVE_CHAIN_STATUSES: ActionStatus[] = ["QUEUED", "SIGNING", "BROADCAST", "CONFIRMED"];

/** Sum a query's `v` column as BigInt (overflow-safe, unlike SQLite's int64 SUM). */
function sumBigIntColumn(rows: Row[]): bigint {
  return rows.reduce((acc, r) => acc + BigInt(String(r["v"])), 0n);
}

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
    // busy_timeout MUST be set before journal_mode: switching to WAL takes a
    // brief exclusive lock, and when the whole stack (watchers + signer +
    // coordinator + dispatcher) opens this shared DB at once, the loser needs
    // to wait rather than fail instantly with SQLITE_BUSY ("database is locked").
    this.db.exec(
      `PRAGMA busy_timeout=10000;
       PRAGMA journal_mode=WAL;
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
       CREATE TABLE IF NOT EXISTS pegin_rate(
         sender TEXT NOT NULL,
         ts     INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_pegin_rate ON pegin_rate(sender, ts);
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
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 0, ?)`,
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
        input.lastError ?? null,
        now,
        now,
        input.parentId ?? null,
      );
    const inserted = Number(res.changes) === 1;
    if (!inserted) {
      // The id already exists. A REPLAY of the same event carries the same digest (silent,
      // correct idempotency). A DIFFERENT digest under the same id means two DISTINCT events
      // collided on one idempotency key (e.g. a cross-chain sourceId clash) — the second would
      // otherwise be silently dropped and its output lost. Fail closed: halt for review (M5).
      const existing = this.db.prepare("SELECT digest FROM action_outbox WHERE id = ?").get(input.id) as
        | { digest?: string }
        | undefined;
      if (existing && existing.digest !== input.digest) {
        const reason = `idempotency-key collision on ${input.id}: stored digest ${existing.digest} != incoming ${input.digest} (two distinct events mapped to one id)`;
        console.error(`[store] CRITICAL: ${reason} -> pausing`);
        await this.pause(reason);
      }
    }
    return inserted;
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

  async setFee(id: string, feeMilliViz: bigint): Promise<void> {
    this.db
      .prepare("UPDATE action_outbox SET fee_milli_viz = ?, updated_at = ? WHERE id = ?")
      .run(feeMilliViz.toString(), Date.now(), id);
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

  async unsweptFeesMilliViz(chain?: RemoteChainId): Promise<bigint> {
    // Sum in JS with BigInt, NOT SQLite SUM(CAST(... AS INTEGER)): a running total
    // past 2^63 makes SQLite fall back to a REAL, and BigInt("…e+18") throws. Milli-VIZ
    // amounts are unbounded 2^64-plus, so the SUM must live outside SQLite's int64.
    const ph = MINTED_STATUSES.map(() => "?").join(",");
    const chainFilter = chain ? " AND remote_chain = ?" : "";
    const chainArgs: string[] = chain ? [chain] : [];
    const minted = this.db
      .prepare(`SELECT fee_milli_viz AS v FROM action_outbox WHERE direction='PEG_IN' AND status IN (${ph})${chainFilter}`)
      .all(...MINTED_STATUSES, ...chainArgs) as Row[];
    const swept = this.db
      .prepare(`SELECT amount_milli_viz AS v FROM action_outbox WHERE direction='FEE_SWEEP' AND status='CONFIRMED'${chainFilter}`)
      .all(...chainArgs) as Row[];
    const v = sumBigIntColumn(minted) - sumBigIntColumn(swept);
    return v; // signed: negative = over-swept anomaly, surfaced by recon (see interface doc, M10)
  }

  async minPegInFeeMilliViz(chain?: RemoteChainId): Promise<bigint | null> {
    const ph = MINTED_STATUSES.map(() => "?").join(",");
    const chainFilter = chain ? " AND remote_chain = ?" : "";
    const chainArgs: string[] = chain ? [chain] : [];
    // Exclude ONLY not-yet-pinned BROADCAST rows (fee still default 0 mid-mint). A
    // CONFIRMED row always carries its positive pinned fee (pinFee runs before broadcast
    // and the CONFIRMED transition COALESCEs, never clobbering it), so fee 0 on a
    // CONFIRMED row is a genuine mis-pin/masking attempt and MUST count toward the floor.
    // See the interface doc on minPegInFeeMilliViz.
    const rows = this.db
      .prepare(`SELECT fee_milli_viz AS v FROM action_outbox WHERE direction='PEG_IN' AND status IN (${ph}) AND NOT (status='BROADCAST' AND fee_milli_viz='0')${chainFilter}`)
      .all(...MINTED_STATUSES, ...chainArgs) as Row[];
    if (rows.length === 0) return null;
    // Min in JS with BigInt (fee_milli_viz is stored as TEXT; see unsweptFeesMilliViz note).
    return rows.reduce((m, r) => {
      const v = BigInt(String(r["v"]));
      return v < m ? v : m;
    }, BigInt(String(rows[0]!["v"])));
  }

  async activeRemoteChains(): Promise<RemoteChainId[]> {
    const ph = ACTIVE_CHAIN_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT remote_chain AS c FROM action_outbox
         WHERE direction='PEG_IN' AND remote_chain IS NOT NULL AND status IN (${ph})`,
      )
      .all(...ACTIVE_CHAIN_STATUSES) as Row[];
    return rows.map((r) => String(r["c"]) as RemoteChainId);
  }

  async recordCap(amountMilliViz: bigint, now: number): Promise<void> {
    this.db
      .prepare("INSERT INTO cap_window(ts, amount_milli_viz) VALUES(?, ?)")
      .run(now, amountMilliViz.toString());
  }

  async capSumMilliViz(sinceMs: number, now: number): Promise<bigint> {
    // Prune expired entries, then sum the live window in JS with BigInt (see
    // unsweptFeesMilliViz: SQLite SUM overflows int64 into a lossy REAL).
    this.db.prepare("DELETE FROM cap_window WHERE ts < ?").run(sinceMs);
    const rows = this.db
      .prepare("SELECT amount_milli_viz AS v FROM cap_window WHERE ts <= ?")
      .all(now) as Row[];
    return sumBigIntColumn(rows);
  }

  async tryReserveCap(amountMilliViz: bigint, capMilliViz: bigint, sinceMs: number, now: number): Promise<boolean> {
    // BEGIN IMMEDIATE takes the write lock up front, so concurrent processes serialize here and
    // the prune+sum+insert is a single atomic read-modify-write (busy_timeout makes losers wait,
    // not fail). Without it, two watchers could both read the sum, both pass, both insert -> cap
    // bypassed AND the per-deposit pause never trips (neither breaches on its own).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM cap_window WHERE ts < ?").run(sinceMs);
      const rows = this.db
        .prepare("SELECT amount_milli_viz AS v FROM cap_window WHERE ts <= ?")
        .all(now) as Row[];
      const sum = sumBigIntColumn(rows);
      if (sum + amountMilliViz > capMilliViz) {
        this.db.exec("COMMIT"); // keep the prune; record nothing
        return false;
      }
      this.db.prepare("INSERT INTO cap_window(ts, amount_milli_viz) VALUES(?, ?)").run(now, amountMilliViz.toString());
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back / no tx */ }
      throw e;
    }
  }

  async tryReserveSenderRate(sender: string, maxPerWindow: number, windowMs: number, now: number): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM pegin_rate WHERE ts < ?").run(now - windowMs);
      const row = this.db.prepare("SELECT COUNT(*) AS c FROM pegin_rate WHERE sender = ? AND ts > ?").get(sender, now - windowMs) as { c: number };
      if (Number(row.c) >= maxPerWindow) { this.db.exec("COMMIT"); return false; }
      this.db.prepare("INSERT INTO pegin_rate(sender, ts) VALUES(?, ?)").run(sender, now);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* noop */ }
      throw e;
    }
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

  async getCursor(name: string): Promise<number> {
    // Cursor keys share the gateway_state KV; the caller-supplied "cursor:*" name
    // namespaces them away from the pause flag.
    const v = this.getKey(name);
    return v ? Number(v) : 0;
  }
  async setCursor(name: string, value: number): Promise<void> {
    if (value <= (await this.getCursor(name))) return; // monotonic
    this.setKey(name, String(value));
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
  async getState(key: string): Promise<string | null> {
    return this.getKey(key);
  }
  async setState(key: string, value: string): Promise<void> {
    this.setKey(key, value);
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
  private readonly cursors = new Map<string, number>();
  private paused = false;
  private reason = "";

  async enqueue(input: EnqueueInput): Promise<boolean> {
    const existing = this.rows.get(input.id);
    if (existing) {
      // Same digest = idempotent replay (silent). Different digest = two distinct events on
      // one id — fail closed rather than silently drop the second (M5; mirrors the sqlite path).
      if (existing.digest !== input.digest) {
        const reason = `idempotency-key collision on ${input.id}: stored digest ${existing.digest} != incoming ${input.digest} (two distinct events mapped to one id)`;
        console.error(`[store] CRITICAL: ${reason} -> pausing`);
        await this.pause(reason);
      }
      return false;
    }
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
      lastError: input.lastError ?? null,
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
  async setFee(id: string, feeMilliViz: bigint): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.feeMilliViz = feeMilliViz;
      r.updatedAt = Date.now();
    }
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
  async unsweptFeesMilliViz(chain?: RemoteChainId): Promise<bigint> {
    let minted = 0n;
    let swept = 0n;
    for (const r of this.rows.values()) {
      if (r.direction === "PEG_IN" && (r.status === "BROADCAST" || r.status === "CONFIRMED") && (!chain || r.remoteChain === chain)) minted += r.feeMilliViz;
      if (r.direction === "FEE_SWEEP" && r.status === "CONFIRMED" && (!chain || r.remoteChain === chain)) swept += r.amountMilliViz;
    }
    const v = minted - swept;
    return v; // signed: negative = over-swept anomaly, surfaced by recon (see interface doc, M10)
  }
  async minPegInFeeMilliViz(chain?: RemoteChainId): Promise<bigint | null> {
    let min: bigint | null = null;
    for (const r of this.rows.values()) {
      if (r.direction === "PEG_IN" && (r.status === "BROADCAST" || r.status === "CONFIRMED") && (!chain || r.remoteChain === chain)) {
        // Skip ONLY a not-yet-pinned BROADCAST row (fee still default 0 mid-mint). A
        // CONFIRMED row always carries its positive pinned fee, so fee 0 there is a
        // genuine mis-pin/masking attempt and MUST count — see the interface doc.
        if (r.status === "BROADCAST" && r.feeMilliViz === 0n) continue;
        if (min === null || r.feeMilliViz < min) min = r.feeMilliViz;
      }
    }
    return min;
  }
  async activeRemoteChains(): Promise<RemoteChainId[]> {
    const active = new Set<RemoteChainId>();
    for (const r of this.rows.values()) {
      if (
        r.direction === "PEG_IN" &&
        r.remoteChain &&
        (r.status === "QUEUED" || r.status === "SIGNING" || r.status === "BROADCAST" || r.status === "CONFIRMED")
      ) {
        active.add(r.remoteChain);
      }
    }
    return [...active];
  }
  async recordCap(amountMilliViz: bigint, now: number): Promise<void> {
    this.caps.push({ ts: now, amount: amountMilliViz });
  }
  async capSumMilliViz(sinceMs: number, now: number): Promise<bigint> {
    return this.caps.filter((e) => e.ts >= sinceMs && e.ts <= now).reduce((a, e) => a + e.amount, 0n);
  }
  async tryReserveCap(amountMilliViz: bigint, capMilliViz: bigint, sinceMs: number, now: number): Promise<boolean> {
    // Single-process store: JS is single-threaded, so sum+push is already atomic.
    const sum = this.caps.filter((e) => e.ts >= sinceMs && e.ts <= now).reduce((a, e) => a + e.amount, 0n);
    if (sum + amountMilliViz > capMilliViz) return false;
    this.caps.push({ ts: now, amount: amountMilliViz });
    return true;
  }
  private readonly rates: Array<{ sender: string; ts: number }> = [];
  async tryReserveSenderRate(sender: string, maxPerWindow: number, windowMs: number, now: number): Promise<boolean> {
    const cutoff = now - windowMs;
    const count = this.rates.filter((r) => r.sender === sender && r.ts > cutoff).length;
    if (count >= maxPerWindow) return false;
    this.rates.push({ sender, ts: now });
    return true;
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
  async getCursor(name: string): Promise<number> {
    return this.cursors.get(name) ?? 0;
  }
  async setCursor(name: string, value: number): Promise<void> {
    if (value > (this.cursors.get(name) ?? 0)) this.cursors.set(name, value); // monotonic
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
  private readonly state = new Map<string, string>();
  async getState(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }
  async setState(key: string, value: string): Promise<void> {
    this.state.set(key, value);
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
