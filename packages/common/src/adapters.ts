import type {
  Approval,
  CanonicalAction,
  RemoteBurn,
  SolanaMintProposal,
  TonMintProposal,
  VizDeposit,
  VizReleaseProposal,
} from "./types";

// Chain adapters isolate the external SDKs behind narrow interfaces. The
// trust-critical core depends only on these interfaces, so it can be unit-tested
// with no network and so SDK upgrades stay contained.
//
// Two roles:
//   HomeChain   = VIZ — locks/releases the native asset (one home chain).
//   RemoteChain = TON today, Solana next, ... — mints/burns wrapped VIZ.
// Adding a network means implementing RemoteChain<ItsMintProposal> + a watcher.

/** The home chain (VIZ): where value is locked and released. */
export interface VizChain {
  /** Current last-irreversible block number (from get_dynamic_global_properties). */
  lastIrreversibleBlock(): Promise<number>;
  /** Deposits to the gateway account that are irreversible as of `upToBlock`. */
  irreversibleDepositsSince(fromBlock: number, upToBlock: number): Promise<VizDeposit[]>;
  /** Current gateway account VIZ balance, in milli-VIZ (for reconciliation). */
  gatewayBalanceMilliViz(): Promise<bigint>;
  /**
   * Whether a VIZ account exists. A peg-out release to a non-existent account
   * can never land, so the peg-out path checks this BEFORE the irreversible burn
   * to avoid stranding user funds (no wVIZ, no VIZ).
   */
  accountExists(name: string): Promise<boolean>;
  /** Current head block, for building a release proposal's TaPoS + expiration. */
  buildReleaseProposal(action: CanonicalAction, gatewayAccount: string): Promise<VizReleaseProposal>;
  /** Broadcast the proposal with >= T merged signatures (order-independent). Returns trx id. */
  broadcastRelease(proposal: VizReleaseProposal, signatures: string[]): Promise<string>;
}

/**
 * A remote chain that holds wrapped VIZ. `MintProposal` is the chain-specific
 * payload operators authorize (TON: a multisig-v2 order; Solana: an SPL mint tx).
 * The `mintAuth` argument carries whatever the chain needs to authorize the mint
 * (off-chain signatures for VIZ/Solana-SPL, or is unused where approval is
 * on-chain like TON multisig-v2).
 */
export interface RemoteChain<MintProposal = unknown> {
  /** Finalized chain height (TON masterchain seqno, Solana finalized slot, ...). */
  finalizedHeight(): Promise<number>;
  /** wrapped-VIZ returns/burns observed final within (fromHeight, toHeight]. */
  finalizedBurnsSince(fromHeight: number, toHeight: number): Promise<RemoteBurn[]>;
  /** Circulating wrapped-VIZ supply, in milli-VIZ (for reconciliation). */
  circulatingSupplyMilliViz(): Promise<bigint>;
  /**
   * Whether the recipient's wVIZ holding account already exists (Solana ATA /
   * TON jetton-wallet). Read ONCE by the proposer and pinned into the proposal
   * (`destProvisioned`); a false value means the gateway pays rent to create it,
   * which the peg-in activation surcharge compensates. See fees.ts.
   */
  isDestinationProvisioned(recipient: string): Promise<boolean>;
  /** Authorize + submit a mint of wrapped VIZ. Returns a tx/op id. */
  submitMint(proposal: MintProposal, mintAuth: string[]): Promise<string>;
}

/** Back-compat alias for the current TON implementation. */
export type TonChain = RemoteChain<TonMintProposal>;

export interface Signer {
  readonly operatorId: string;
  /** Validate the proposal against the action, then secp256k1-sign the VIZ release. */
  signVizRelease(action: CanonicalAction, proposal: VizReleaseProposal): Promise<Approval>;
  /** Validate the proposal against the action, then approve the remote mint. */
  approveTonMint(action: CanonicalAction, proposal: TonMintProposal): Promise<Approval>;
  /** Validate the proposal against the action, then approve the remote Solana mint. */
  approveSolanaMint(action: CanonicalAction, proposal: SolanaMintProposal): Promise<Approval>;
}
