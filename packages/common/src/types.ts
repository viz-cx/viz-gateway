// Chain-agnostic domain types shared across all gateway services.
// These types are the trust-critical contract: every operator must agree on
// exactly the same canonical representation of an action before signing it.

export type Direction = "PEG_IN" | "PEG_OUT";

/** A confirmed VIZ -> gateway deposit (peg-in source event). */
export interface VizDeposit {
  /** VIZ transaction id (hex). Unique source key for idempotency. */
  trxId: string;
  /** Operation index within the transaction. */
  opIndex: number;
  /** Block number the transfer landed in. */
  blockNum: number;
  /** Sender VIZ account. */
  from: string;
  /** Must equal the gateway VIZ account. */
  to: string;
  /** Amount in integer milli-VIZ (1 VIZ = 1000). */
  amountMilliViz: bigint;
  /** Destination TON address parsed from the transfer memo. */
  tonDestination: string;
}

/**
 * A confirmed wrapped-VIZ burn/return on a REMOTE chain (peg-out source event).
 * Chain-neutral so any remote network (TON, Solana, ...) maps onto it:
 *   TON    -> sourceId = message hash, height = masterchain seqno
 *   Solana -> sourceId = tx signature, height = slot
 */
export interface RemoteBurn {
  /** Unique source-event id on the remote chain (idempotency key). */
  sourceId: string;
  /** Remote-chain height/seqno/slot at which it was observed final. */
  height: number;
  /** Burner address on the remote chain. */
  from: string;
  /** Amount in integer milli-VIZ. */
  amountMilliViz: bigint;
  /** Destination VIZ account parsed from the burn comment/memo. */
  homeDestination: string;
}

/**
 * The canonical destination action derived deterministically from a source
 * event. Every honest operator computes byte-identical bodies, so their
 * signatures aggregate. `id` is the idempotency key; `digest` is the stable
 * hash operators sign over.
 */
export interface CanonicalAction {
  direction: Direction;
  /** Idempotency key = source event key (trxId:opIndex or msgHash). */
  id: string;
  /** Recipient on the destination chain. */
  recipient: string;
  /** Amount in integer milli-VIZ. */
  amountMilliViz: bigint;
  /** Deterministic content hash operators sign over (hex). */
  digest: string;
}

/** A single operator's signature/approval over a CanonicalAction.digest. */
export interface Approval {
  actionId: string;
  operatorId: string;
  /** Hex signature (secp256k1 for VIZ release, ed25519 approval for TON mint). */
  signature: string;
}

/**
 * A VIZ release proposal: the EXACT unsigned transfer skeleton every operator
 * must sign for their secp256k1 signatures to merge. TaPoS (ref block) and
 * expiration are fixed by the proposer (coordinator) so all operators sign
 * byte-identical bytes. Each operator independently validates that this matches
 * the canonical action before signing.
 */
export interface VizReleaseProposal {
  refBlockNum: number;
  refBlockPrefix: number;
  expiration: string; // "YYYY-MM-DDThh:mm:ss" (UTC, no timezone suffix)
  from: string; // gateway account
  to: string; // recipient account
  amount: string; // VIZ asset string, e.g. "10.000 VIZ"
  memo: string; // = CanonicalAction.id (idempotency / traceability)
}

/**
 * A TON mint approval proposal. In multisig-v2, signers approve an *order*; the
 * bytes they sign are the order cell hash. The proposer builds the order via the
 * official wrapper and distributes `orderHashHex`; each operator validates the
 * order's parameters against the canonical action, then ed25519-signs the hash.
 */
export interface TonMintProposal {
  orderSeqno: string;
  toAddress: string; // recipient TON address
  amountMilliViz: string;
  orderHashHex: string; // exact 32-byte order hash operators sign (hex)
}

/**
 * A Solana mint proposal. SPL multisig collects M signatures on a SINGLE
 * transaction (off-chain-collected, like VIZ), so the wired write-path will
 * carry the unsigned mint_to transaction for signers to co-sign. Deferred until
 * the TON round-trip validates the RemoteChain interface.
 */
export interface SolanaMintProposal {
  recipient: string; // base58 owner address to receive wVIZ
  amountMilliViz: string;
}

/** An operator's public identity on both chains. */
export interface OperatorRef {
  /** Public operator id, e.g. "op-1". */
  id: string;
  /** VIZ secp256k1 public key (the "VIZ..."-prefixed string), used in the active key_auths. */
  vizPubkey: string;
  /** TON ed25519 public key (hex), used by the TON rotation path (follow-up plan). */
  tonPubkey: string;
}

export interface FederationManifest {
  /** Total signers N. */
  n: number;
  /** Threshold T. */
  threshold: number;
  /** Public operator set. */
  operators: OperatorRef[];
}
