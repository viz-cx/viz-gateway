// Idempotency ledger: guarantees each source event is acted on at most once.
// Keyed on the canonical action id (VIZ trxId:opIndex or TON msgHash).

export type ActionState = "SEEN" | "SIGNED" | "BROADCAST" | "CONFIRMED";

export interface LedgerRecord {
  id: string;
  state: ActionState;
  updatedAt: number;
}

export interface IdempotencyStore {
  /** Returns the record if present, else undefined. */
  get(id: string): Promise<LedgerRecord | undefined>;
  /**
   * Atomically inserts a SEEN record if absent. Returns true if this caller
   * inserted it (i.e. first sighting), false if it already existed.
   */
  claim(id: string): Promise<boolean>;
  /** Advances state. */
  setState(id: string, state: ActionState): Promise<void>;
}

/**
 * In-memory implementation for tests/dev. Production should back this with
 * SQLite (single operator) or Postgres (HA) and rely on a UNIQUE constraint
 * for the atomic claim. See STORE_URL in .env.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, LedgerRecord>();

  async get(id: string): Promise<LedgerRecord | undefined> {
    return this.map.get(id);
  }

  async claim(id: string): Promise<boolean> {
    if (this.map.has(id)) return false;
    this.map.set(id, { id, state: "SEEN", updatedAt: Date.now() });
    return true;
  }

  async setState(id: string, state: ActionState): Promise<void> {
    const rec = this.map.get(id);
    if (rec) {
      rec.state = state;
      rec.updatedAt = Date.now();
    } else {
      this.map.set(id, { id, state, updatedAt: Date.now() });
    }
  }
}
