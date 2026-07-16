// Chain-agnostic domain types shared across all gateway services.
// These types are the trust-critical contract: every operator must agree on
// exactly the same canonical representation of an action before signing it.

export type Direction = "PEG_IN" | "PEG_OUT";

/** Remote chains the gateway can mint wrapped VIZ on. */
export type RemoteChainId = "GRAM" | "SOLANA";

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
  /** Remote chain to mint wrapped VIZ on, determined by the receiving backing account. */
  remoteChain: RemoteChainId;
  /**
   * Destination address on `remoteChain`, from the transfer memo. Canonicalized to the
   * empty-string sentinel "" when the memo is missing or malformed, so every operator
   * derives an identical canonical digest for a destination-less deposit regardless of
   * the exact invalid bytes. Only a valid address is ever a non-empty string here.
   */
  remoteDestination: string;
  /**
   * True iff `remoteDestination` is a valid mint target for `remoteChain`. A false value
   * means the deposit has NO mint destination (empty/malformed memo): it must NEVER be
   * minted (enforced at the signer, `validatePegIn`) and is instead routed to an
   * auto-refund back to the sender. The reader reconstructs the deposit either way rather
   * than dropping it, so a no-memo deposit is durably tracked and returned, not stranded.
   */
  destinationValid: boolean;
}

/**
 * A confirmed wrapped-VIZ burn/return on a REMOTE chain (peg-out source event).
 * Chain-neutral so any remote network (TON, Solana, ...) maps onto it:
 *   TON    -> sourceId = message hash, height = masterchain seqno
 *   Solana -> sourceId = tx signature, height = slot
 */
export interface RemoteBurn {
  /** Source chain identifier — determines which backing account releases VIZ. */
  chain: RemoteChainId;
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
   * Remote chain for this action: the mint chain (PEG_IN) or the source burn chain
   * (PEG_OUT). Committed into the digest for both directions.
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
 * A TON mint approval proposal (Phase B: multisig-v2 ON-CHAIN approvals).
 *
 * Unlike VIZ/Solana, TON multisig-v2 has NO off-chain signature aggregation: an
 * approval is an on-chain `Order.approve` message sent from the operator's OWN
 * wallet. So the coordinator (keyless) only DESCRIBES the order here; each
 * operator's signer performs the on-chain effect (propose or approve) itself.
 *
 * `orderAddr` is the deterministic order address f(multisig, nextOrderSeqno) — a
 * durable idempotency key: it is persisted before any operator proposes, so a
 * re-drive after a crash targets the SAME order (existence check → no second mint).
 * `orderHashHex` is the REAL packed order cell hash; every operator rebuilds the
 * mint order from (minter, toAddress, net) and asserts it matches before acting,
 * binding the on-chain effect to the recipient/amount it independently validated.
 * There is no designated proposer: whichever live operator the coordinator contacts
 * first while the order is still absent opens it (`new_order`); the rest `approve`.
 * The role therefore fails over across operators, so one stuck/unfunded/offline
 * operator cannot deadlock the mint.
 */
export interface GramMintProposal {
  orderSeqno: string; // multisig nextOrderSeqno at build time ("" if reused on recovery)
  orderAddr: string; // deterministic order address f(multisig, orderSeqno) — the idempotency key
  toAddress: string; // recipient TON address
  amountMilliViz: string; // = NET (gross − fee); the amount actually minted
  /** Pinned when the order is built: was the destination jetton-wallet already provisioned? */
  destProvisioned: boolean;
  orderHashHex: string; // exact 32-byte packed order cell hash operators rebuild + verify (hex)
  actionId: string; // canonical action id (idempotency / traceability)
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

/**
 * The Solana rotation handoff artifact (rotation-solana.json). Carries the
 * Phase-B setAuthority mechanics; the WHO (new operator set) is read from the
 * master RotationProposal, never duplicated here.
 */
export interface SolanaRotationProposal {
  version: 1;
  chainId: string;
  oldMultisig: string; // current SPL multisig = current mint+freeze authority (base58)
  newMultisig: string; // freshly created SPL multisig that will receive authority (base58)
  mint: string; // wVIZ Token-2022 mint (base58)
  nonceAccount: string; // dedicated rotation durable-nonce account (base58)
  nonceValue: string; // stored nonce (blockhash-equivalent) at propose time (base58)
  feePayer: string; // submitter: fee payer + nonce authority (base58)
  signers: string[]; // CURRENT multisig members (base58), sorted — the multiSigners
  messageB64: string; // base64 of the compiled legacy message bytes (the signed digest)
  signatures: string[]; // "<memberPubkeyB58>:<sigHex>" partials
}

/** An operator's public identity across all chains. */
export interface OperatorRef {
  /** Public operator id, e.g. "op-1". */
  id: string;
  /** VIZ secp256k1 public key (the "VIZ..."-prefixed string), used in the active key_auths. */
  vizPubkey: string;
  /** TON ed25519 public key (hex), used by the TON rotation path. */
  tonPubkey: string;
  /** Solana ed25519 public key (base58), used as an SPL multisig member in the Solana rotation path. */
  solanaPubkey: string;
}

/**
 * Peg-in fee constants committed to the manifest so every operator uses identical
 * values — divergence would cause computed `net` to differ and signatures to fail to merge.
 * All *MilliViz values are integer milli-VIZ (1 VIZ = 1000 milli-VIZ).
 */
export interface ManifestFees {
  floorMilliViz: bigint;
  /** Basis points (20 = 0.20%). */
  bps: number;
  activationSurchargeMilliViz: { SOLANA: bigint; GRAM: bigint };
  mintGasFloorMilliViz: { SOLANA: bigint; GRAM: bigint };
}

export interface FederationManifest {
  /** Total signers N. */
  n: number;
  /** Threshold T. */
  threshold: number;
  /** Public operator set. */
  operators: OperatorRef[];
  /** Fee constants. When present, takes precedence over env vars. */
  fees?: ManifestFees;
}
