// Chain-agnostic domain types shared across all gateway services.
// These types are the trust-critical contract: every operator must agree on
// exactly the same canonical representation of an action before signing it.

export type Direction = "PEG_IN" | "PEG_OUT";

/** Remote chains the gateway can mint wrapped VIZ on. */
export type RemoteChainId = "TON" | "SOLANA";

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
  /** Remote chain to mint wrapped VIZ on, parsed from the memo's "<chain>:" prefix. */
  remoteChain: RemoteChainId;
  /** Destination address on `remoteChain`, parsed from the transfer memo. */
  remoteDestination: string;
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
  /**
   * Target remote chain for a PEG_IN mint, committed into the digest. Absent for
   * PEG_OUT, which always releases on the VIZ home chain.
   */
  remoteChain?: RemoteChainId;
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
  amountMilliViz: string; // = NET (gross − fee); the amount actually minted
  /** Pinned by the proposer: was the destination jetton-wallet already provisioned? */
  destProvisioned: boolean;
  orderHashHex: string; // exact 32-byte order hash operators sign (hex)
}

/**
 * A Solana mint proposal. The SPL multisig collects M ed25519 signatures on a
 * SINGLE transaction (off-chain, like VIZ). The tx uses a durable NONCE instead
 * of a recent blockhash, so the signed bytes never expire until the nonce is
 * consumed — operators sign asynchronously. `messageB64` is the exact compiled
 * (legacy) message every operator signs; the structured fields let each operator
 * rebuild and verify those bytes before signing.
 *
 * `signers` is the chosen signing SUBSET (size = threshold M), sorted ascending:
 * mint_to marks every listed signer as required, so all of them must sign.
 */
export interface SolanaMintProposal {
  recipient: string; // base58 owner address to receive wVIZ
  amountMilliViz: string; // = NET (gross − fee); the amount actually minted
  /** Pinned by the proposer: was the destination ATA already provisioned? */
  destProvisioned: boolean;
  mint: string; // wVIZ Token-2022 mint (base58)
  multisig: string; // SPL multisig = mint authority (base58)
  signers: string[]; // M member pubkeys (base58), sorted ascending — the multiSigners
  feePayer: string; // submitter pubkey: fee payer + nonce authority + ATA funder (base58)
  nonceAccount: string; // durable nonce account (base58)
  nonceValue: string; // stored nonce (blockhash-equivalent) at proposal time (base58)
  decimals: number; // 3
  messageB64: string; // base64 of the compiled legacy message bytes (the signed digest)
  /** Canonical action id embedded as a memo in the mint tx for on-chain idempotency checks. */
  actionId?: string;
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
