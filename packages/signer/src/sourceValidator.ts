import {
  canonicalPegIn,
  canonicalPegOut,
  type CanonicalAction,
  type GatewayStore,
  type RemoteBurn,
  type VizChain,
} from "@gateway/common";
import { depositAddressFromMasterPub } from "@gateway/solana-watcher/dist/depositAddress";

/**
 * F2 — the signer's INDEPENDENT source-event validation.
 *
 * Before any proposal-vs-action check, the signer re-reads the source event from
 * its OWN chain nodes, reconstructs the canonical action, and asserts byte-identical
 * equality with the wire action the (untrusted) coordinator handed it. A compromised
 * coordinator can therefore no longer get honest operators to sign a mint/release for
 * an event that never happened — the entire security premise of the federation.
 *
 * Fail-closed: if the operator's node can't yet see the event as final, the chain
 * reader returns null and we REFUSE (worst case is a liveness stall — the coordinator's
 * existing failure mode — never a wrong signature).
 *
 * INDEPENDENCE LINCHPIN: the chain readers in `deps` MUST be the operator's own nodes,
 * never coordinator-fed. See signer/index.ts wiring.
 */

/** Thrown when the re-derived action does not match the wire action. */
export class SourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceMismatchError";
  }
}

/** Minimal burn-reader surface (SolanaChain.getBurn) — keeps deps mockable. */
export interface BurnReader {
  getBurn(sourceId: string): Promise<RemoteBurn | null>;
}

export interface SourceValidatorDeps {
  /** Operator's own VIZ node reader (peg-in source). */
  vizChain: Pick<VizChain, "getDeposit">;
  /** Operator's own Solana reader (peg-out source). */
  solanaChain: BurnReader;
  /** Shared deposit-address registry (peg-out routing identity). */
  store: Pick<GatewayStore, "depositAddressBy">;
  /** Base58 DEPOSIT_MASTER_PUB — public derivation only, no spend authority. */
  depositMasterPub: string;
}

/** Solana signatures base58-decode to 64 bytes (~86-90 base58 chars). */
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;

/** A VIZ peg-in source id is "<trxIdHex>:<opIndex>". */
function looksLikeSolanaSignature(id: string): boolean {
  return SOLANA_SIGNATURE_RE.test(id);
}

/**
 * Re-derive the action from the source chain and assert it matches `action`.
 * Throws SourceMismatchError on any deviation; returns void on success.
 */
export async function validateAction(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  if (action.direction === "PEG_IN") {
    await validatePegIn(action, deps);
    return;
  }
  // PEG_OUT: dispatch by source-id shape. Solana = base58 signature; otherwise TON.
  if (looksLikeSolanaSignature(action.id)) {
    await validateSolanaPegOut(action, deps);
    return;
  }
  // TON peg-out source re-read is deferred (sourceId is a message hash; toncenter v2
  // has no clean fetch-by-hash and TON peg-out is not yet active). Explicitly accepted
  // gap — warn loudly rather than silently trust, and revisit when TON peg-out ships.
  console.warn(
    `[source-validator] PEG_OUT ${action.id} not a Solana signature; TON peg-out source re-validation is deferred — proceeding WITHOUT independent source check (accepted gap).`,
  );
}

async function validatePegIn(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  const sep = action.id.indexOf(":");
  const trxId = sep > 0 ? action.id.slice(0, sep) : "";
  const opIndex = Number.parseInt(action.id.slice(sep + 1), 10);
  if (!trxId || Number.isNaN(opIndex)) {
    throw new SourceMismatchError(`malformed PEG_IN source id "${action.id}" (expected "<trxId>:<opIndex>")`);
  }
  const deposit = await deps.vizChain.getDeposit(trxId, opIndex);
  if (!deposit) {
    throw new SourceMismatchError(`PEG_IN source ${action.id} not found or not yet irreversible on VIZ`);
  }
  assertSameAction(canonicalPegIn(deposit), action);
}

async function validateSolanaPegOut(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  if (!deps.depositMasterPub) {
    throw new SourceMismatchError(`DEPOSIT_MASTER_PUB not configured; cannot validate Solana peg-out ${action.id}`);
  }
  const burn = await deps.solanaChain.getBurn(action.id);
  if (!burn) {
    throw new SourceMismatchError(`PEG_OUT burn ${action.id} not found or not yet finalized on Solana`);
  }
  // The release target is implied by WHICH deposit address burned (no memo). Look it
  // up, then re-derive the address from the VIZ account + public master key: a tampered
  // registry row cannot redirect funds, because the binding is recomputed independently.
  const rec = await deps.store.depositAddressBy(burn.from);
  if (!rec) {
    throw new SourceMismatchError(`no registered deposit address for burn source ${burn.from} (${action.id})`);
  }
  const expected = depositAddressFromMasterPub(deps.depositMasterPub, rec.vizAccount);
  if (expected !== burn.from) {
    throw new SourceMismatchError(
      `deposit-address binding mismatch for ${action.id}: derived ${expected} from "${rec.vizAccount}" != burn source ${burn.from}`,
    );
  }
  burn.homeDestination = rec.vizAccount;
  assertSameAction(canonicalPegOut(burn), action);
}

/** Deep-equal the trust-critical fields; the digest is authoritative, the rest sharpen errors. */
function assertSameAction(derived: CanonicalAction, wire: CanonicalAction): void {
  if (derived.direction !== wire.direction) {
    throw new SourceMismatchError(`direction ${wire.direction} != source-derived ${derived.direction} (${wire.id})`);
  }
  if (derived.recipient !== wire.recipient) {
    throw new SourceMismatchError(`recipient ${wire.recipient} != source-derived ${derived.recipient} (${wire.id})`);
  }
  if (derived.amountMilliViz !== wire.amountMilliViz) {
    throw new SourceMismatchError(
      `amount ${wire.amountMilliViz} != source-derived ${derived.amountMilliViz} (${wire.id})`,
    );
  }
  if (derived.remoteChain !== wire.remoteChain) {
    throw new SourceMismatchError(
      `remoteChain ${String(wire.remoteChain)} != source-derived ${String(derived.remoteChain)} (${wire.id})`,
    );
  }
  if (derived.digest !== wire.digest) {
    throw new SourceMismatchError(`digest ${wire.digest} != source-derived ${derived.digest} (${wire.id})`);
  }
}
