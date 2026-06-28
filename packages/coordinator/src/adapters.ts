import {
  actionToWire,
  pegInFeePolicyFor,
  quotePegIn,
  type Approval,
  type CanonicalAction,
  type GatewayFeeConfig,
  type SolanaMintProposal,
} from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import type { Broadcaster, BuildResult, Proposal, SignerClient } from "./orchestrator";

/** Calls an operator's signer /approve endpoint over HTTP (push model). */
export class HttpSignerClient implements SignerClient {
  constructor(
    public readonly operatorId: string,
    private readonly endpoint: string,
  ) {}

  async approve(action: CanonicalAction, proposal: Proposal): Promise<Approval> {
    const res = await fetch(`${this.endpoint.replace(/\/$/, "")}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: actionToWire(action), proposal }),
    });
    if (res.status === 423) throw new Error(`signer ${this.endpoint} is paused`);
    if (!res.ok) throw new Error(`signer ${this.endpoint} -> HTTP ${res.status}`);
    return (await res.json()) as Approval;
  }
}

/** PEG_OUT: build a VIZ release proposal and broadcast the signed transfer. */
export class VizReleaseBroadcaster implements Broadcaster {
  constructor(private readonly chain: VizJsChain, private readonly gatewayAccount: string) {}

  async buildProposal(action: CanonicalAction): Promise<BuildResult> {
    // PEG_OUT / FEE_SWEEP / REFUND are all fee-free VIZ releases.
    return { proposal: await this.chain.buildReleaseProposal(action, this.gatewayAccount), feeMilliViz: 0n };
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    // proposal is a VizReleaseProposal here (PEG_OUT).
    return this.chain.broadcastRelease(proposal as never, signatures);
  }

  async actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }> {
    const found = await this.chain.releaseByMemo(action.id);
    return found ? { executed: true, txid: found.txid } : { executed: false };
  }
}

/** PEG_IN: build a TON mint proposal (NET + pinned provisioning) and submit the order. */
export class TonMintBroadcaster implements Broadcaster {
  constructor(
    private readonly chain: TonHttpChain,
    private readonly fees: GatewayFeeConfig,
  ) {}

  async buildProposal(action: CanonicalAction): Promise<BuildResult> {
    // Read destination provisioning ONCE and pin it; compute NET from gross+policy.
    const destProvisioned = await this.chain.isDestinationProvisioned(action.recipient);
    const q = quotePegIn(action.amountMilliViz, destProvisioned, pegInFeePolicyFor(this.fees, "TON"));
    if (!q.ok) throw new Error(`PEG_IN ${action.id} below minimum (refund): need >= ${q.minMilliViz} mVIZ`);
    // The real orderHashHex must be the multisig-v2 order cell hash, built via
    // the official wrapper. Until the contract is deployed we use the canonical
    // action digest as a deterministic 32-byte stand-in so the ed25519 approval
    // flow is exercisable; submitMintOrder still requires the wrapper to execute.
    const proposal: Proposal = {
      orderSeqno: "0",
      toAddress: action.recipient,
      amountMilliViz: q.b.net.toString(),
      destProvisioned,
      orderHashHex: action.digest,
    };
    return { proposal, feeMilliViz: q.b.fee };
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    return this.chain.submitMint(proposal as never, signatures);
  }

  async actionExecuted(_action: CanonicalAction): Promise<{ executed: boolean; txid?: string }> {
    // TON live multisig-v2 order-status query is deferred until the contract is
    // deployed (orderSeqno is still a stub "0"). Conservative: assume not executed
    // so a crash recovery goes through the normal signing path.
    return { executed: false };
  }
}

/** PEG_IN (Solana): build a durable-nonce SPL mint proposal (NET + pinned provisioning). */
export class SolanaMintBroadcaster implements Broadcaster {
  constructor(
    private readonly chain: SolanaChain,
    /** Committed signing subset (the M multiSigners that must all sign). */
    private readonly signerSet: string[],
    private readonly fees: GatewayFeeConfig,
  ) {}

  async buildProposal(action: CanonicalAction): Promise<BuildResult> {
    const destProvisioned = await this.chain.isDestinationProvisioned(action.recipient);
    const q = quotePegIn(action.amountMilliViz, destProvisioned, pegInFeePolicyFor(this.fees, "SOLANA"));
    if (!q.ok) throw new Error(`PEG_IN ${action.id} below minimum (refund): need >= ${q.minMilliViz} mVIZ`);
    const proposal = await this.chain.buildMintProposal(action.recipient, q.b.net, destProvisioned, this.signerSet, action.id);
    return { proposal, feeMilliViz: q.b.fee };
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    return this.chain.submitMint(proposal as SolanaMintProposal, signatures);
  }

  async actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }> {
    const found = await this.chain.mintByActionId(action.id);
    return found ? { executed: true, txid: found.txid } : { executed: false };
  }
}
