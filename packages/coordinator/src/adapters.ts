import {
  actionToWire,
  pegInFeePolicyFor,
  quotePegIn,
  type Approval,
  type CanonicalAction,
  type GatewayFeeConfig,
  type GatewayStore,
  type SolanaMintProposal,
  type VizReleaseProposal,
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

/** Minimal outbox surface the broadcasters need for idempotent delivery. */
type IdempotencyStore = Pick<GatewayStore, "get" | "setStatus">;

/** PEG_OUT: build a VIZ release proposal and broadcast the signed transfer. */
export class VizReleaseBroadcaster implements Broadcaster {
  constructor(
    private readonly chain: VizJsChain,
    private readonly gatewayAccount: string,
    private readonly store: IdempotencyStore,
  ) {}

  async buildProposal(action: CanonicalAction): Promise<BuildResult> {
    // PEG_OUT / FEE_SWEEP / REFUND are all fee-free VIZ releases.
    return { proposal: await this.chain.buildReleaseProposal(action, this.gatewayAccount), feeMilliViz: 0n };
  }

  async broadcast(action: CanonicalAction, proposal: Proposal, signatures: string[]): Promise<string> {
    const p = proposal as VizReleaseProposal;
    // Persist-before-send: the VIZ trx id is deterministic from the proposal (independent
    // of signatures), so we record it BEFORE broadcasting. If we crash mid-send, recovery
    // confirms by this exact id (confirmReleaseByTxId) instead of a bounded memo scan that
    // could miss an older release and issue a SECOND real transfer. VIZ transfers are not
    // nonce-deduped on-chain, so this is the only on-chain idempotency backstop they have.
    const txid = this.chain.transactionId(p);
    await this.store.setStatus(action.id, "BROADCAST", { txid });
    const sent = await this.chain.broadcastRelease(p, signatures);
    if (sent && sent !== txid) {
      console.warn(`[viz-broadcast] node txid ${sent} != computed ${txid} for ${action.id} (serializer drift?)`);
    }
    return sent || txid;
  }

  async actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }> {
    const rec = await this.store.get(action.id);
    // Persist-before-send invariant: a row with no txid was never broadcast, so there is
    // nothing on-chain to find — return immediately, no RPC on the happy path.
    if (!rec?.txid) return { executed: false };
    const found = await this.chain.confirmReleaseByTxId(rec.txid);
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
    private readonly store: IdempotencyStore,
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
    const rec = await this.store.get(action.id);
    // A persisted txid means submitMint already returned a signature — it landed.
    if (rec?.txid) return { executed: true, txid: rec.txid };
    // Recovery only: a retried row may have landed before a crash dropped the response.
    // Scan by the embedded action-id memo then. First-attempt rows (attempts === 0) skip
    // the ~100-signature scan entirely — durable-nonce dedup makes a fresh re-broadcast
    // safe even if this misses, so the steady-state happy path pays no RPC cost.
    if (rec && rec.attempts > 0) {
      const found = await this.chain.mintByActionId(action.id);
      if (found) return { executed: true, txid: found.txid };
    }
    return { executed: false };
  }
}
