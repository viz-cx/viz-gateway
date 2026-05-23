import type {
  Approval,
  CanonicalAction,
  Signer,
  TonMintProposal,
  VizReleaseProposal,
} from "@gateway/common";
import { milliToViz } from "@gateway/viz-watcher/dist/vizChain";
import { signRelease } from "@gateway/viz-watcher/dist/vizSign";
import { keyPairFromMnemonic, signMintApproval } from "@gateway/ton-watcher/dist/tonSign";

/**
 * The ONLY component that holds keys. Each operator runs exactly one.
 *
 * Crucially, the signer re-validates that the proposal it was handed actually
 * matches the canonical action the operator independently derived from the
 * source event, BEFORE signing. A malicious coordinator therefore cannot get an
 * honest operator to sign a transfer to the wrong recipient or amount.
 *
 * Keys are passed in here for the scaffold; in production this class wraps an
 * HSM/KMS and the raw secret never leaves the device.
 */
export class KeyedSigner implements Signer {
  constructor(
    public readonly operatorId: string,
    private readonly vizWif: string,
    private readonly tonMnemonic: string,
  ) {}

  async signVizRelease(action: CanonicalAction, proposal: VizReleaseProposal): Promise<Approval> {
    if (action.direction !== "PEG_OUT") throw new Error("signVizRelease expects a PEG_OUT action");
    if (proposal.to !== action.recipient) {
      throw new Error(`proposal.to (${proposal.to}) != action.recipient (${action.recipient})`);
    }
    if (proposal.amount !== milliToViz(action.amountMilliViz)) {
      throw new Error(`proposal.amount (${proposal.amount}) != action amount (${milliToViz(action.amountMilliViz)})`);
    }
    if (proposal.memo !== action.id) {
      throw new Error(`proposal.memo (${proposal.memo}) != action.id (${action.id})`);
    }
    const signature = signRelease(proposal, this.vizWif);
    return { actionId: action.id, operatorId: this.operatorId, signature };
  }

  async approveTonMint(action: CanonicalAction, proposal: TonMintProposal): Promise<Approval> {
    if (action.direction !== "PEG_IN") throw new Error("approveTonMint expects a PEG_IN action");
    if (proposal.toAddress !== action.recipient) {
      throw new Error(`proposal.toAddress (${proposal.toAddress}) != action.recipient (${action.recipient})`);
    }
    if (proposal.amountMilliViz !== action.amountMilliViz.toString()) {
      throw new Error(`proposal amount (${proposal.amountMilliViz}) != action amount (${action.amountMilliViz})`);
    }
    if (!this.tonMnemonic) throw new Error("TON signer mnemonic not set; refusing to sign");
    const { secretKey } = await keyPairFromMnemonic(this.tonMnemonic);
    const signature = signMintApproval(proposal, secretKey);
    return { actionId: action.id, operatorId: this.operatorId, signature };
  }
}
