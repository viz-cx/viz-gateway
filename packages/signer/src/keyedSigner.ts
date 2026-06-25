import type {
  Approval,
  CanonicalAction,
  GatewayFeeConfig,
  Signer,
  SolanaMintProposal,
  TonMintProposal,
  VizReleaseProposal,
} from "@gateway/common";
import { baseFee, pegInFeePolicyFor } from "@gateway/common";
import { milliToViz } from "@gateway/viz-watcher/dist/vizChain";
import { signRelease } from "@gateway/viz-watcher/dist/vizSign";
import { keyPairFromMnemonic, signMintApproval } from "@gateway/ton-watcher/dist/tonSign";
import { signMint } from "@gateway/solana-watcher/dist/solanaSign";

/**
 * The ONLY component that holds keys. Each operator runs exactly one.
 *
 * Crucially, the signer re-validates that the proposal it was handed actually
 * matches the canonical action the operator independently derived from the
 * source event, BEFORE signing. A malicious coordinator therefore cannot get an
 * honest operator to sign a transfer to the wrong recipient or amount.
 *
 * For a PEG_IN the action carries GROSS; the signer independently re-derives the
 * base fee from gross (a pure function, so all operators agree) and accepts the
 * proposer-pinned `destProvisioned` flag for the small activation surcharge, then
 * asserts `proposal.net == gross − base − activation`. A wrong flag only shifts
 * <= the surcharge between the user and fees.gate (never the backing), so it is
 * safe to trust the boolean while the net arithmetic is verified.
 *
 * Keys are passed in here for the scaffold; in production this class wraps an
 * HSM/KMS and the raw secret never leaves the device.
 */
export class KeyedSigner implements Signer {
  constructor(
    public readonly operatorId: string,
    private readonly vizWif: string,
    private readonly tonMnemonic: string,
    private readonly fees: GatewayFeeConfig,
    private readonly solanaSecret: Uint8Array | null = null,
  ) {}

  /** Re-derive the expected NET for a PEG_IN and assert the proposal matches. */
  private assertNet(
    action: CanonicalAction,
    chain: "SOLANA" | "TON",
    destProvisioned: boolean,
    proposalNet: string,
  ): void {
    const policy = pegInFeePolicyFor(this.fees, chain);
    const gross = action.amountMilliViz; // PEG_IN action carries gross
    const base = baseFee(gross, policy);
    const activation = destProvisioned ? 0n : policy.activationSurchargeMilliViz;
    const net = gross - base - activation;
    if (net <= 0n) throw new Error(`net <= 0 for ${action.id} (gross ${gross}, fee ${base + activation})`);
    if (proposalNet !== net.toString()) {
      throw new Error(`proposal net (${proposalNet}) != derived net (${net}) for ${action.id}`);
    }
  }

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
    // proposal.amountMilliViz is NET; re-derive base fee from gross, accept the
    // pinned destProvisioned flag for the activation surcharge.
    this.assertNet(action, "TON", proposal.destProvisioned, proposal.amountMilliViz);
    if (!this.tonMnemonic) throw new Error("TON signer mnemonic not set; refusing to sign");
    const { secretKey } = await keyPairFromMnemonic(this.tonMnemonic);
    const signature = signMintApproval(proposal, secretKey);
    return { actionId: action.id, operatorId: this.operatorId, signature };
  }

  async approveSolanaMint(action: CanonicalAction, proposal: SolanaMintProposal): Promise<Approval> {
    if (action.direction !== "PEG_IN") throw new Error("approveSolanaMint expects a PEG_IN action");
    if (proposal.recipient !== action.recipient) {
      throw new Error(`proposal.recipient (${proposal.recipient}) != action.recipient (${action.recipient})`);
    }
    // proposal.amountMilliViz is NET; re-derive base fee from gross, accept the
    // pinned destProvisioned flag for the activation surcharge.
    this.assertNet(action, "SOLANA", proposal.destProvisioned, proposal.amountMilliViz);
    if (!this.solanaSecret) throw new Error("Solana signer secret not set; refusing to sign");
    const signature = signMint(proposal, this.solanaSecret);
    return { actionId: action.id, operatorId: this.operatorId, signature };
  }
}
