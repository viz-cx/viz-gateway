// Durable outbox ledger: every source event becomes exactly one row, advanced
// through a status machine with retries, so an action is never lost on a failed
// delivery (the previous design claimed an id then dropped it on any error).
// Keyed on the canonical action id (VIZ trxId:opIndex or remote sourceId).

export type ActionStatus =
  | "SEEN" // detected, idempotency-claimed
  | "QUEUED" // passed checks, ready to submit to the coordinator
  | "SIGNING" // coordinator collecting partials
  | "BROADCAST" // submitted to chain, has txid
  | "CONFIRMED" // finality verified
  | "HELD" // failed caps/minimum — awaits refund or manual review
  | "REFUNDING" // delivery window exhausted — returning funds to sender
  | "REFUNDED" // funds returned
  | "FAILED"; // terminal: even the refund could not be signed (federation degraded)

/** What kind of on-chain action a row drives. */
export type OutboxDirection = "PEG_IN" | "PEG_OUT" | "FEE_SWEEP" | "REFUND";

export type OutboxRemoteChain = "TON" | "SOLANA";

/** A persisted outbox row: the action plus its delivery state. */
export interface OutboxRecord {
  id: string;
  direction: OutboxDirection;
  remoteChain?: OutboxRemoteChain;
  recipient: string;
  /** Source-chain sender (for a PEG_IN refund back to origin); null otherwise. */
  sender: string | null;
  amountMilliViz: bigint;
  /** Fee withheld (base + activation) for a PEG_IN; 0 otherwise. */
  feeMilliViz: bigint;
  digest: string;
  status: ActionStatus;
  attempts: number;
  lastError: string | null;
  txid: string | null;
  createdAt: number;
  updatedAt: number;
  /** Earliest time the dispatcher may (re)try this row (backoff). */
  nextAttemptAt: number;
}

/** Fields needed to first-claim + persist an action. */
export interface EnqueueInput {
  id: string;
  direction: OutboxDirection;
  remoteChain?: OutboxRemoteChain;
  recipient: string;
  sender?: string;
  amountMilliViz: bigint;
  feeMilliViz?: bigint;
  digest: string;
  /** Initial status; default "SEEN". */
  status?: ActionStatus;
}

/** Optional fields to update alongside a status transition. */
export interface StatusPatch {
  attempts?: number;
  lastError?: string | null;
  txid?: string | null;
  nextAttemptAt?: number;
}

/**
 * A registered peg-out deposit address (Variant A). The owner address is derived
 * deterministically from `vizAccount`; we persist the mapping so the scanner knows
 * which (finite) set of addresses to watch and can map an incoming transfer back
 * to its VIZ release target.
 */
export interface DepositAddressRecord {
  vizAccount: string;
  solAddress: string;
  wvizAta: string;
  createdAt: number;
  scanTime: number;
  priority: number;
}

// Implementations live in store.ts: SqliteGatewayStore (persistent, shared) and
// InMemoryGatewayStore (tests). Both implement the GatewayStore interface.
