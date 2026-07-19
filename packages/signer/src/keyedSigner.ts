import type {
  Approval,
  CanonicalAction,
  GatewayFeeConfig,
  Signer,
  SolanaMintProposal,
  GramMintProposal,
  VizReleaseProposal,
} from "@gateway/common";
import { baseFee, GatewayAccounts, pegInFeePolicyFor } from "@gateway/common";
import { milliToViz } from "@gateway/viz-watcher/dist/vizChain";
import { signRelease } from "@gateway/viz-watcher/dist/vizSign";
import { encodeReceipt, type GramApprovalClient } from "@gateway/gram-watcher/dist/gramApprove";
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
 * Keys are passed in here as raw material. Custody is NOT delegated to an HSM/KMS
 * (decided 2026-07-06): the M-of-N federation is the custody control — each operator
 * holds its own key on its own machine, under a separate person, so theft requires T
 * independent machines. Keys stay local; at-rest they are protected by a passphrase
 * keystore (no plaintext on disk/env), not by moving them off-box. See AUDIT.md §8.
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
  /**
   * Expected fee-payer / nonce-authority pubkey (the designated submitter). Optional:
   * when set, the signer rejects a proposal whose `feePayer` differs, so a compromised
   * coordinator cannot name an arbitrary fee payer (a wrong one would fail the on-chain
   * nonce advance anyway — this fails closed earlier, at validation). Omitted in spikes
   * and when SOLANA_SUBMITTER_PUBKEY is unset.
   */
  feePayer?: string;
}

/** Explicit test-only sentinel: pass this to KeyedSigner to disable F2 source validation. */
export const DISABLED_SOURCE_VALIDATION = Symbol("DISABLED_SOURCE_VALIDATION");

export class KeyedSigner implements Signer {
  private readonly validateSource: SourceValidator | null;

  constructor(
    public readonly operatorId: string,
    private readonly vizWif: string,
    /**
     * RETAINED for constructor-arg stability, no longer used for signing. TON mints
     * are authorized by on-chain multisig approvals: the operator's mnemonic lives in
     * (and is used only by) the injected `gramApprover`, never here. See approveGramMint.
     */
    private readonly _tonMnemonic: string,
    private readonly fees: GatewayFeeConfig,
    private readonly solanaSecret: Uint8Array | null = null,
    validateSource?: SourceValidator | typeof DISABLED_SOURCE_VALIDATION,
    private readonly solanaPins: SolanaPins | null = null,
    /**
     * TON on-chain approval client (Phase B). PEG_IN TON approvals are on-chain
     * effects (multisig-v2 `new_order`/`approve`) sent from THIS operator's own
     * wallet, not off-chain signatures — so the signer delegates the effect here.
     * Null when TON is not wired on this operator (then a TON PEG_IN is refused).
     */
    private readonly gramApprover: GramApprovalClient | null = null,
    private readonly accounts: GatewayAccounts | null = null,
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
    chain: "SOLANA" | "GRAM",
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
    if (this.accounts) {
      if (!action.remoteChain) throw new Error(`release ${action.id} missing remoteChain — cannot verify from-account`);
      const expectedFrom = this.accounts.accountFor(action.remoteChain);
      if (proposal.from !== expectedFrom) {
        throw new Error(`proposal.from (${proposal.from}) != expected backing account ${expectedFrom} for ${action.remoteChain} (${action.id})`);
      }
    }
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

  async approveGramMint(action: CanonicalAction, proposal: GramMintProposal): Promise<Approval> {
    if (action.direction !== "PEG_IN") throw new Error("approveGramMint expects a PEG_IN action");
    await this.assertSource(action);
    if (proposal.toAddress !== action.recipient) {
      throw new Error(`proposal.toAddress (${proposal.toAddress}) != action.recipient (${action.recipient})`);
    }
    // proposal.amountMilliViz is NET; re-derive base fee from gross and accept the pinned
    // destProvisioned flag for the activation surcharge — identical to the Solana path.
    this.assertNet(action, "GRAM", proposal.destProvisioned, proposal.amountMilliViz);
    if (!this.gramApprover) throw new Error("GRAM approver not configured on this signer; refusing to approve");
    // On-chain effect from THIS operator's own wallet: open the order if it is still
    // absent when we are asked (no single designated proposer — the role fails over across
    // live operators), otherwise approve it. The approver re-derives the order cell and
    // asserts its hash matches proposal.orderHashHex, binding the on-chain action to the
    // recipient/amount validated above.
    const receipt = await this.gramApprover.approveMint(proposal);
    return { actionId: action.id, operatorId: this.operatorId, signature: encodeReceipt(receipt) };
  }

  async approveGramReturn(action: CanonicalAction, proposal: GramMintProposal): Promise<Approval> {
    if (action.direction !== "GRAM_RETURN") throw new Error("approveGramReturn expects a GRAM_RETURN action");
    await this.assertSource(action); // validateGramReturn: dest re-check + recipient + exact amount + digest
    if (proposal.toAddress !== action.recipient) {
      throw new Error(`proposal.toAddress (${proposal.toAddress}) != action.recipient (${action.recipient})`);
    }
    // Exact amount — no band: the return moves EXACTLY the net the source-validator re-derived
    // (gross − refundFee), and refundFeeMilliViz is one fixed manifest constant all operators share.
    if (BigInt(proposal.amountMilliViz) !== action.amountMilliViz) {
      throw new Error(`proposal amount (${proposal.amountMilliViz}) != action amount (${action.amountMilliViz}) for ${action.id}`);
    }
    if (!this.gramApprover) throw new Error("GRAM approver not configured on this signer; refusing to approve");
    const receipt = await this.gramApprover.approveReturn(proposal);
    return { actionId: action.id, operatorId: this.operatorId, signature: encodeReceipt(receipt) };
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
      // feePayer is pinned only when the operator configured the expected submitter pubkey.
      if (pins.feePayer) mismatches.push(["feePayer", proposal.feePayer]);
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
