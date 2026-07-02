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
 *
 * F2: `validateSource` re-derives the action from the operator's OWN chain view and
 * throws on any mismatch. It runs BEFORE the proposal-vs-action checks (which remain
 * as defense-in-depth). The production signer (index.ts) always injects it. Disabling
 * it is allowed ONLY for offline spikes and MUST be an explicit, greppable opt-in via
 * `DISABLED_SOURCE_VALIDATION` — a forgotten argument throws rather than silently
 * signing unvalidated.
 */
export type SourceValidator = (action: CanonicalAction) => Promise<void>;

/**
 * The Solana accounts this operator trusts, read from its OWN config. Pinning these
 * means a compromised coordinator cannot point the signer at an attacker-controlled
 * mint / mint-authority multisig / durable-nonce account (same "trust your own
 * config, not the wire" principle F2 applies to the source event). Optional: spikes
 * omit it; the production signer (index.ts) always supplies it when Solana is wired.
 */
export interface SolanaPins {
  mint: string;
  multisig: string;
  nonceAccount: string;
}

/** Explicit test-only sentinel: pass this to KeyedSigner to disable F2 source validation. */
export const DISABLED_SOURCE_VALIDATION = Symbol("DISABLED_SOURCE_VALIDATION");

export class KeyedSigner implements Signer {
  private readonly validateSource: SourceValidator | null;

  constructor(
    public readonly operatorId: string,
    private readonly vizWif: string,
    private readonly tonMnemonic: string,
    private readonly fees: GatewayFeeConfig,
    private readonly solanaSecret: Uint8Array | null = null,
    validateSource?: SourceValidator | typeof DISABLED_SOURCE_VALIDATION,
    private readonly solanaPins: SolanaPins | null = null,
  ) {
    if (validateSource === undefined) {
      // A forgotten validator must never degrade to "sign without a source check".
      throw new Error(
        "KeyedSigner: a source validator is required; pass DISABLED_SOURCE_VALIDATION explicitly for offline/test use only.",
      );
    }
    this.validateSource = validateSource === DISABLED_SOURCE_VALIDATION ? null : validateSource;
  }

  /** F2 gate: independently re-validate the source event before signing. */
  private async assertSource(action: CanonicalAction): Promise<void> {
    if (!this.validateSource) {
      console.warn(
        `[signer] SOURCE VALIDATION DISABLED for ${action.id}: explicit test-only sentinel — NEVER production.`,
      );
      return;
    }
    await this.validateSource(action);
  }

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
    await this.assertSource(action);
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
    await this.assertSource(action);
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
    await this.assertSource(action);
    // Pin the Solana accounts to this operator's own config: a compromised coordinator
    // must not be able to redirect the mint to an attacker-controlled mint / authority
    // multisig / nonce account. Skipped only when unconfigured (spikes).
    if (this.solanaPins) {
      const pins = this.solanaPins;
      const mismatches: Array<[keyof SolanaPins, string]> = [
        ["mint", proposal.mint],
        ["multisig", proposal.multisig],
        ["nonceAccount", proposal.nonceAccount],
      ];
      for (const [field, got] of mismatches) {
        if (got !== pins[field]) {
          throw new Error(`proposal.${field} (${got}) != signer-configured ${field} (${pins[field]}) for ${action.id}`);
        }
      }
    }
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
