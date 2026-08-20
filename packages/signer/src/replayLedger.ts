import { createHash } from "node:crypto";
import type {
  CanonicalAction,
  GatewayStore,
  SolanaMintProposal,
  GramMintProposal,
  VizReleaseProposal,
} from "@gateway/common";
import { releaseTxId } from "@gateway/viz-watcher/dist/vizSign";
import { isGramMintProposal, isSolanaMintProposal } from "./routeApproval";

/**
 * Signer-side REPLAY LEDGER (deferred hardening from the PR #129 audit).
 *
 * F2 proves the source event is real; nothing proved this operator hadn't signed it
 * BEFORE. Proposals are coordinator-built and not deduplicated by the destination
 * chain (a VIZ release with fresh TaPoS is a new txid; a GRAM order with a fresh
 * seqno is a new order — the order-cell hash binds only minter+recipient+amount),
 * so a compromised coordinator could harvest T signatures over a SECOND proposal
 * for the same real event and land both: a repeatable double release/mint.
 *
 * The ledger records, in THIS operator's own store, the one proposal key signed per
 * action id. Rules:
 *   - unseen action → first-claim the key (atomic; a lost race refuses) and sign;
 *   - identical key → sign again freely (identical bytes = identical tx/order, the
 *     chain can land it at most once — this keeps every legit crash-retry alive);
 *   - different key, GRAM/Solana → REFUSE. The honest coordinator pins orderAddr /
 *     the durable-nonce message per action and reuses it on every re-drive, so a
 *     different key is never a legit retry (manual override: RUNBOOK "replay ledger");
 *   - different key, VIZ → the honest coordinator DOES rebuild TaPoS every round, so
 *     allow — but only once the previously signed tx is provably dead: own-node head
 *     time past its expiration (+ margin) AND the exact txid never landed. Worst case
 *     a legit sub-threshold retry waits out the ~60s expiration window; a replay
 *     attempt against a landed release is refused forever.
 *
 * Fail-closed by construction: every uncertain path refuses (a liveness stall — the
 * coordinator's existing failure mode — never a second live signature).
 */
export class ReplayRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRefusalError";
  }
}

/**
 * Margin past the proposal's expiration before a re-sign is allowed: covers node/head
 * clock granularity and the visibility lag between a tx landing just before expiration
 * and our own node serving it via getTransaction.
 */
const VIZ_EXPIRY_MARGIN_MS = 60_000;

const VIZ_KEY_PREFIX = "viz-tx:";

export interface ReplayLedgerDeps {
  store: Pick<GatewayStore, "getSignedProposal" | "putSignedProposal">;
  /** Own-node chain clock (VizJsChain.headBlockTimeMs). */
  headBlockTimeMs(): Promise<number>;
  /** Own-node exact-txid landed check (VizJsChain.confirmReleaseByTxId != null). */
  releaseLanded(txid: string): Promise<boolean>;
}

/**
 * Derive the ledger key identifying the exact signable effect of a proposal:
 * VIZ → the deterministic release txid (signature-independent, exactly what the
 * landed-check needs); GRAM → the order address (the on-chain idempotency key);
 * Solana → hash of the compiled message (what operators actually sign).
 */
export function proposalKey(
  p: VizReleaseProposal | GramMintProposal | SolanaMintProposal,
): { key: string; expiresAtMs: number } {
  if (isSolanaMintProposal(p)) {
    return { key: `solana-msg:${createHash("sha256").update(p.messageB64).digest("hex")}`, expiresAtMs: 0 };
  }
  if (isGramMintProposal(p)) {
    return { key: `gram-order:${p.orderAddr}`, expiresAtMs: 0 };
  }
  const expiresAtMs = Date.parse(`${p.expiration}Z`); // proposal expirations are UTC without a suffix
  if (Number.isNaN(expiresAtMs)) {
    throw new ReplayRefusalError(`unparseable proposal expiration "${p.expiration}" — refusing to sign`);
  }
  return { key: `${VIZ_KEY_PREFIX}${releaseTxId(p)}`, expiresAtMs };
}

/** Gate an /approve request against the ledger; throws ReplayRefusalError, or claims the key. */
export async function assertNotReplay(
  action: CanonicalAction,
  proposal: VizReleaseProposal | GramMintProposal | SolanaMintProposal,
  deps: ReplayLedgerDeps,
): Promise<void> {
  const { key, expiresAtMs } = proposalKey(proposal);
  const prev = await deps.store.getSignedProposal(action.id);
  if (!prev) {
    if (await deps.store.putSignedProposal(action.id, key, expiresAtMs, null)) return;
    // Lost the first-claim race to a concurrent /approve. Same key = same effect, fine.
    const won = await deps.store.getSignedProposal(action.id);
    if (won?.key === key) return;
    throw new ReplayRefusalError(
      `${action.id}: lost first-claim race to a concurrent DIFFERENT proposal (${won?.key}) — refusing`,
    );
  }
  if (prev.key === key) return; // identical bytes; the chain lands them at most once

  if (!key.startsWith(VIZ_KEY_PREFIX) || !prev.key.startsWith(VIZ_KEY_PREFIX)) {
    throw new ReplayRefusalError(
      `${action.id}: already signed as ${prev.key}, now asked for ${key} — the coordinator reuses the ` +
        `order/nonce on legit re-drives, so a different proposal is a replay attempt (manual override: ` +
        `RUNBOOK "signer replay ledger")`,
    );
  }
  const headMs = await deps.headBlockTimeMs();
  if (headMs <= prev.expiresAtMs + VIZ_EXPIRY_MARGIN_MS) {
    throw new ReplayRefusalError(
      `${action.id}: a previously signed release (${prev.key}) is still live until ` +
        `${new Date(prev.expiresAtMs + VIZ_EXPIRY_MARGIN_MS).toISOString()} — refusing a second live signature`,
    );
  }
  const prevTxid = prev.key.slice(VIZ_KEY_PREFIX.length);
  if (await deps.releaseLanded(prevTxid)) {
    throw new ReplayRefusalError(
      `${action.id}: release ALREADY LANDED on VIZ as ${prevTxid} — signing another is a double release (replay attack?)`,
    );
  }
  if (!(await deps.store.putSignedProposal(action.id, key, expiresAtMs, prev.key))) {
    throw new ReplayRefusalError(`${action.id}: replay-ledger CAS lost to a concurrent update — refusing`);
  }
}
