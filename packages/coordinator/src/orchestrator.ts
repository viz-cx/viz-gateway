import {
  ApprovalSet,
  type Approval,
  type CanonicalAction,
  type SolanaMintProposal,
  type TonMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";

export type Proposal = VizReleaseProposal | TonMintProposal | SolanaMintProposal;

/** Asks one operator's signer to validate + sign a proposal. */
export interface SignerClient {
  readonly operatorId: string;
  approve(action: CanonicalAction, proposal: Proposal): Promise<Approval>;
}

/** A built proposal plus the fee withheld (0 unless it is a PEG_IN mint). */
export interface BuildResult {
  proposal: Proposal;
  feeMilliViz: bigint;
}

/** Builds the shared proposal for an action and broadcasts it once signed. */
export interface Broadcaster {
  buildProposal(action: CanonicalAction): Promise<BuildResult>;
  broadcast(action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string>;
  /**
   * Check whether this action was already executed on the destination chain. Called
   * before every coordinator round to short-circuit crash-recovery re-submissions.
   * Returns `{ executed: true, txid }` if the action is found on-chain, or
   * `{ executed: false }` if it must still be broadcast.
   */
  actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }>;
}

export interface OrchestrationResult {
  actionId: string;
  approvals: number;
  threshold: number;
  broadcast: boolean;
  txid?: string;
  /** Fee withheld for a PEG_IN (drives the FEE_SWEEP); 0 otherwise. */
  feeMilliViz?: string;
  error?: string;
}

/**
 * Drives one action to completion: build the single shared proposal, collect
 * operator approvals up to the threshold, then broadcast. Works at 1-of-1 (solo
 * bootstrap) and unchanged at 7-of-11. The orchestrator holds no keys; signers
 * independently validate the proposal against the action before signing, so a
 * compromised coordinator cannot get an honest signer to sign the wrong thing.
 */
export class Orchestrator {
  constructor(
    private readonly threshold: number,
    private readonly operators: string[],
    private readonly signers: SignerClient[],
    private readonly broadcaster: Broadcaster,
    /**
     * Persist the withheld PEG_IN fee onto the outbox row the moment it is known
     * (before broadcast). This makes the fee durable independently of the result
     * reaching the dispatcher: if the response is lost or an already-executed action
     * later takes the recovery path (where the rebuild can fail -> fee 0), the
     * dispatcher can still read the pinned fee and spawn the FEE_SWEEP. Optional so
     * offline spikes need no store.
     */
    private readonly persistFee?: (actionId: string, feeMilliViz: bigint) => Promise<void>,
  ) {}

  /** Pin a positive PEG_IN fee onto the row; best-effort (never blocks the action). */
  private async pinFee(action: CanonicalAction, feeMilliViz: bigint): Promise<void> {
    if (!this.persistFee || action.direction !== "PEG_IN" || feeMilliViz <= 0n) return;
    try {
      await this.persistFee(action.id, feeMilliViz);
    } catch (err) {
      console.warn(`[orchestrator] ${action.id} fee pin failed (non-fatal): ${String(err)}`);
    }
  }

  async process(action: CanonicalAction): Promise<OrchestrationResult> {
    // Idempotency: if the action already landed on-chain (e.g. the process crashed
    // after broadcast but before CONFIRMED), short-circuit to avoid a double-mint or
    // double-release. buildProposal is still called for the fee amount (PEG_IN).
    const check = await this.broadcaster.actionExecuted(action);
    if (check.executed) {
      // Recover the fee (PEG_IN) for the FEE_SWEEP, but never let a rebuild failure strand
      // an action that ALREADY landed on-chain: buildProposal hits the network (e.g. Solana
      // getNonce, or the below-minimum guard can throw), and re-deriving it here is best-
      // effort only. On failure, report fee 0 and proceed to CONFIRMED — the dispatcher
      // already persisted the real fee at first delivery, so sweep accounting is unaffected.
      let feeMilliViz = 0n;
      try {
        ({ feeMilliViz } = await this.broadcaster.buildProposal(action));
        await this.pinFee(action, feeMilliViz);
      } catch (err) {
        console.warn(`[orchestrator] ${action.id} executed but fee rebuild failed (using 0): ${String(err)}`);
      }
      console.log(`[orchestrator] ${action.id} already executed on-chain (${check.txid ?? ""}); skipping broadcast`);
      return {
        actionId: action.id,
        approvals: 0,
        threshold: this.threshold,
        broadcast: true,
        txid: check.txid,
        feeMilliViz: feeMilliViz.toString(),
      };
    }

    const { proposal, feeMilliViz } = await this.broadcaster.buildProposal(action);
    const fee = feeMilliViz.toString();
    // Pin the fee before broadcast so it survives a lost response / crash: recovery
    // reads it back rather than stranding the withheld fee as un-swept surplus.
    await this.pinFee(action, feeMilliViz);
    const set = new ApprovalSet(this.threshold, this.operators);

    for (const signer of this.signers) {
      try {
        set.add(await signer.approve(action, proposal));
      } catch (err) {
        // One signer failing/refusing is expected (offline, or rejects a bad
        // proposal). Keep collecting from the others.
        console.warn(`[orchestrator] signer ${signer.operatorId} did not approve ${action.id}: ${String(err)}`);
      }
      if (set.isMet(action.id)) break;
    }

    const approvals = set.count(action.id);
    if (!set.isMet(action.id)) {
      return { actionId: action.id, approvals, threshold: this.threshold, broadcast: false, feeMilliViz: fee };
    }

    try {
      const txid = await this.broadcaster.broadcast(
        action,
        proposal,
        set.approvals(action.id).map((a) => a.signature),
      );
      return { actionId: action.id, approvals, threshold: this.threshold, broadcast: true, txid, feeMilliViz: fee };
    } catch (err) {
      return {
        actionId: action.id,
        approvals,
        threshold: this.threshold,
        broadcast: false,
        feeMilliViz: fee,
        error: String(err),
      };
    }
  }
}
