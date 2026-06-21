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

/** Builds the shared proposal for an action and broadcasts it once signed. */
export interface Broadcaster {
  buildProposal(action: CanonicalAction): Promise<Proposal>;
  broadcast(action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string>;
}

export interface OrchestrationResult {
  actionId: string;
  approvals: number;
  threshold: number;
  broadcast: boolean;
  txid?: string;
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
  ) {}

  async process(action: CanonicalAction): Promise<OrchestrationResult> {
    const proposal = await this.broadcaster.buildProposal(action);
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
      return { actionId: action.id, approvals, threshold: this.threshold, broadcast: false };
    }

    try {
      const txid = await this.broadcaster.broadcast(
        action,
        proposal,
        set.approvals(action.id).map((a) => a.signature),
      );
      return { actionId: action.id, approvals, threshold: this.threshold, broadcast: true, txid };
    } catch (err) {
      return {
        actionId: action.id,
        approvals,
        threshold: this.threshold,
        broadcast: false,
        error: String(err),
      };
    }
  }
}
