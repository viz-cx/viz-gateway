import {
  actionToWire,
  pegInFeePolicyFor,
  quotePegIn,
  type Approval,
  type CanonicalAction,
  type GatewayFeeConfig,
  type GatewayStore,
  type SolanaMintProposal,
  type GramMintProposal,
  type VizReleaseProposal,
} from "@gateway/common";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { GramHttpChain } from "@gateway/gram-watcher/dist/gramChain";
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
    if (!res.ok) {
      // Surface the signer's error body (the /approve handler returns {error}) so a
      // rejected approval is diagnosable — a bare status code hides *why* it refused.
      const detail = await res.text().catch(() => "");
      throw new Error(`signer ${this.endpoint} -> HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
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

/** Max time the keyless coordinator waits for the on-chain order to self-execute. */
const GRAM_EXECUTE_POLL_MAX_MS = 90_000;
const GRAM_EXECUTE_POLL_INTERVAL_MS = 3_000;

/**
 * PEG_IN (TON): DESCRIBE the mint order for the operators to approve on-chain.
 *
 * Phase B trust model: the coordinator is keyless on TON. It does NOT send
 * `new_order` or hold a signer key — it only builds the order proposal (real cell
 * hash + deterministic address) and pins the idempotency key. Each operator's
 * signer performs the actual on-chain propose/approve from its own wallet
 * (KeyedSigner.approveGramMint → TonApprover). `broadcast` therefore does not
 * submit anything; it confirms the order self-executed once threshold approvals
 * landed. See docs/plan-ton-onchain-approval.md.
 */
export class GramMintBroadcaster implements Broadcaster {
  constructor(
    private readonly chain: GramHttpChain,
    private readonly fees: GatewayFeeConfig,
    private readonly store: IdempotencyStore,
    /** Operator designated to send `new_order` (single-proposer seqno ordering). */
    private readonly proposerOperatorId: string,
  ) {}

  async buildProposal(action: CanonicalAction): Promise<BuildResult> {
    // Read destination provisioning ONCE and pin it; compute NET from gross+policy.
    const destProvisioned = await this.chain.isDestinationProvisioned(action.recipient);
    const q = quotePegIn(action.amountMilliViz, destProvisioned, pegInFeePolicyFor(this.fees, "GRAM"));
    if (!q.ok) throw new Error(`PEG_IN ${action.id} below minimum (refund): need >= ${q.minMilliViz} mVIZ`);
    const net = q.b.net;
    // The REAL packed mint-order cell hash (seqno-independent): every operator rebuilds
    // it from the canonical action and asserts a match before acting, binding each
    // on-chain approval to this exact recipient + amount.
    const orderHashHex = this.chain.orderHashFor(action.recipient, net);

    // Idempotency key = the deterministic order address f(multisig, nextOrderSeqno).
    // REUSE a previously pinned address so a re-drive targets the SAME order (the
    // proposer's own existence check then prevents a second mint); otherwise reserve the
    // current next address and persist it BEFORE any operator proposes. Persisting here —
    // ahead of the approval loop — is what closes the crash-after-propose double-mint
    // window: recovery reads back this exact address instead of recomputing it against an
    // advanced seqno. Only pins on first build (no persisted txid) so the recovery/fee
    // path never regresses a CONFIRMED row's status.
    const rec = await this.store.get(action.id);
    let orderAddr: string;
    let orderSeqno = "";
    if (rec?.txid) {
      orderAddr = rec.txid;
    } else {
      ({ orderAddr, seqno: orderSeqno } = await this.chain.nextOrderAddress());
      await this.store.setStatus(action.id, "BROADCAST", { txid: orderAddr });
    }

    const proposal: Proposal = {
      orderSeqno,
      orderAddr,
      toAddress: action.recipient,
      amountMilliViz: net.toString(),
      destProvisioned,
      orderHashHex,
      actionId: action.id,
      proposerOperatorId: this.proposerOperatorId,
    };
    return { proposal, feeMilliViz: q.b.fee };
  }

  async broadcast(action: CanonicalAction, proposal: Proposal, _signatures: string[]): Promise<string> {
    // Nothing to submit: the order was created + approved on-chain by the operators
    // themselves (keyless coordinator). The order self-executes the instant approvals
    // reach threshold — which is exactly when the orchestrator's approval loop returned —
    // so confirm the order executed and return its address as the txid. `_signatures`
    // are the operators' on-chain approval receipts, carried only for the audit trail.
    const orderAddr = (proposal as GramMintProposal).orderAddr;
    const deadline = Date.now() + GRAM_EXECUTE_POLL_MAX_MS;
    for (;;) {
      if (await this.chain.orderExecuted(orderAddr)) return orderAddr;
      if (Date.now() >= deadline) {
        throw new Error(
          `GRAM order ${orderAddr} for ${action.id} not executed within ${GRAM_EXECUTE_POLL_MAX_MS}ms (approvals below threshold?)`,
        );
      }
      await new Promise((r) => setTimeout(r, GRAM_EXECUTE_POLL_INTERVAL_MS));
    }
  }

  async actionExecuted(action: CanonicalAction): Promise<{ executed: boolean; txid?: string }> {
    const rec = await this.store.get(action.id);
    // Persist-before-approve invariant: a row with no txid was never even proposed, so
    // there is no order on-chain — return immediately, no RPC on the happy path.
    if (!rec?.txid) return { executed: false };
    // Keyed on EXECUTED, not mere existence: an order that exists but is still under
    // threshold must keep collecting approvals (not be treated as done). The
    // no-second-order guard is the operator-side proposer's own existence check, so a
    // re-drive of an unexecuted order is idempotent (proposer no-ops, approvers fill in).
    const executed = await this.chain.orderExecuted(rec.txid);
    return executed ? { executed: true, txid: rec.txid } : { executed: false };
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
