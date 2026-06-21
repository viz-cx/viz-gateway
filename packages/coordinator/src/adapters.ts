import { actionToWire, type Approval, type CanonicalAction, type SolanaMintProposal } from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { TonHttpChain } from "@gateway/ton-watcher/dist/tonChain";
import { SolanaChain } from "@gateway/solana-watcher/dist/solanaChain";
import type { Broadcaster, Proposal, SignerClient } from "./orchestrator";

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

  async buildProposal(action: CanonicalAction): Promise<Proposal> {
    return this.chain.buildReleaseProposal(action, this.gatewayAccount);
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    // proposal is a VizReleaseProposal here (PEG_OUT).
    return this.chain.broadcastRelease(proposal as never, signatures);
  }
}

/** PEG_IN: build a TON mint proposal and submit the multisig order. */
export class TonMintBroadcaster implements Broadcaster {
  constructor(private readonly chain: TonHttpChain) {}

  async buildProposal(action: CanonicalAction): Promise<Proposal> {
    // The real orderHashHex must be the multisig-v2 order cell hash, built via
    // the official wrapper. Until the contract is deployed we use the canonical
    // action digest as a deterministic 32-byte stand-in so the ed25519 approval
    // flow is exercisable; submitMintOrder still requires the wrapper to execute.
    return {
      orderSeqno: "0",
      toAddress: action.recipient,
      amountMilliViz: action.amountMilliViz.toString(),
      orderHashHex: action.digest,
    };
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    return this.chain.submitMint(proposal as never, signatures);
  }
}

/** PEG_IN (Solana): build a durable-nonce SPL mint proposal and submit the signed tx. */
export class SolanaMintBroadcaster implements Broadcaster {
  constructor(
    private readonly chain: SolanaChain,
    /** Committed signing subset (the M multiSigners that must all sign). */
    private readonly signerSet: string[],
  ) {}

  async buildProposal(action: CanonicalAction): Promise<Proposal> {
    return this.chain.buildMintProposal(action, this.signerSet);
  }

  async broadcast(_action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    return this.chain.submitMint(proposal as SolanaMintProposal, signatures);
  }
}
