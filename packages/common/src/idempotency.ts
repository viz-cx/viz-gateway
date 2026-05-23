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

// Implementations live in store.ts: SqliteGatewayStore (persistent, shared) and
// InMemoryGatewayStore (tests). Both implement this interface via GatewayStore.
