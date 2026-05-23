import type {
  Approval,
  CanonicalAction,
  TonBurn,
  TonMintProposal,
  VizDeposit,
  VizReleaseProposal,
} from "./types";

// Chain adapters isolate the external SDKs (viz-js-lib, @ton/ton) behind narrow
// interfaces. The trust-critical core depends only on these interfaces, so it
// can be unit-tested with no network and so SDK upgrades stay contained.

export interface VizChain {
  /** Current last-irreversible block number (from get_dynamic_global_properties). */
  lastIrreversibleBlock(): Promise<number>;
  /** Deposits to the gateway account that are irreversible as of `upToBlock`. */
  irreversibleDepositsSince(fromBlock: number, upToBlock: number): Promise<VizDeposit[]>;
  /** Current gateway account VIZ balance, in milli-VIZ (for reconciliation). */
  gatewayBalanceMilliViz(): Promise<bigint>;
  /** Current head block, for building a release proposal's TaPoS + expiration. */
  buildReleaseProposal(action: CanonicalAction, gatewayAccount: string): Promise<VizReleaseProposal>;
  /** Broadcast the proposal with >= T merged signatures (order-independent). Returns trx id. */
  broadcastRelease(proposal: VizReleaseProposal, signatures: string[]): Promise<string>;
}

export interface TonChain {
  /** Current masterchain seqno. */
  masterchainSeqno(): Promise<number>;
  /** Burns of wVIZ observed final as of `mcSeqno`. */
  finalBurnsSince(fromSeqno: number, mcSeqno: number): Promise<TonBurn[]>;
  /** Circulating wVIZ total supply, in milli-VIZ (for reconciliation). */
  circulatingSupplyMilliViz(): Promise<bigint>;
  /** Submit a multisig order to mint wVIZ once approvals reach threshold. */
  submitMintOrder(proposal: TonMintProposal, signatures: string[]): Promise<string>;
}

export interface Signer {
  readonly operatorId: string;
  /** Validate the proposal against the action, then secp256k1-sign the VIZ release. */
  signVizRelease(action: CanonicalAction, proposal: VizReleaseProposal): Promise<Approval>;
  /** Validate the proposal against the action, then ed25519-sign the TON mint order. */
  approveTonMint(action: CanonicalAction, proposal: TonMintProposal): Promise<Approval>;
}
