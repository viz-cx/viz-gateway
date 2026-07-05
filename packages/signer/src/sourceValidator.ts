import {
  baseFee,
  canonicalPegIn,
  canonicalPegOut,
  pegInFeePolicyFor,
  type CanonicalAction,
  type GatewayFeeConfig,
  type GatewayStore,
  type RemoteBurn,
  type VizChain,
  type VizDeposit,
} from "@gateway/common";
import { depositAddress } from "@gateway/solana-watcher/dist/depositAddress";

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
  /** Operator's own TON reader (peg-out source). */
  tonChain: BurnReader;
  /** Shared deposit-address registry (peg-out routing identity). */
  store: Pick<GatewayStore, "depositAddressBy">;
  /** Public program ID of the burn-only deposit program — used to re-derive deposit PDAs (F2). */
  depositProgramId: string;
  /**
   * The operator's OWN fee configuration — used to independently re-derive the fee a
   * FEE_SWEEP is allowed to sweep. Must be the identical config every operator runs
   * (see GatewayFeeConfig): the fee math is a pure function of the (immutable) gross.
   */
  fees: GatewayFeeConfig;
  /**
   * The operator's OWN fees.gate account. A FEE_SWEEP may only ever release to THIS
   * address; a coordinator-supplied recipient is ignored beyond the equality check.
   */
  feesGateAccount: string;
}

/** Child-action id suffixes for gateway-internal VIZ releases spawned off a PEG_IN. */
const FEE_SWEEP_SUFFIX = ":fee";
const REFUND_SUFFIX = ":refund";

/** Solana signatures base58-decode to 64 bytes (~86-90 base58 chars). */
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;

/** A VIZ peg-in source id is "<trxIdHex>:<opIndex>". */
function looksLikeSolanaSignature(id: string): boolean {
  return SOLANA_SIGNATURE_RE.test(id);
}

/** A TON peg-out source id is the burn tx hash — exactly 64 hex chars. */
const GRAM_TX_HASH_RE = /^[0-9a-f]{64}$/i;
function looksLikeTonTxHash(id: string): boolean {
  return GRAM_TX_HASH_RE.test(id);
}

/**
 * Re-derive the action from the source chain and assert it matches `action`.
 * Throws SourceMismatchError on any deviation; returns void on success.
 *
 * Boundary normalization: the chain readers and memo parsers (getDeposit/getBurn,
 * parseRemoteTarget) throw generic `Error`s on malformed source data. We normalize
 * every failure to SourceMismatchError here so callers (and the spike) can rely on a
 * single fail-closed error type — a generic throw can never be mistaken for "validated".
 */
export async function validateAction(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  try {
    await validateActionInner(action, deps);
  } catch (err) {
    if (err instanceof SourceMismatchError) throw err;
    throw new SourceMismatchError(
      `source validation failed for ${action.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function validateActionInner(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  if (action.direction === "PEG_IN") {
    await validatePegIn(action, deps);
    return;
  }
  // Gateway-INTERNAL VIZ releases spawned off a PEG_IN (FEE_SWEEP / REFUND) have no
  // remote source event to re-read; instead they are re-derived from the PEG_IN they
  // settle. Their ids carry a deterministic suffix on the parent PEG_IN id
  // ("<trxId>:<opIndex>:fee" / ":refund") — unambiguous, because a Solana signature
  // (base58, no ':') and a TON tx hash (64 hex, no ':') can never end this way. Dispatch
  // on the honest id suffix, never on the coordinator-supplied direction/remoteChain.
  if (action.id.endsWith(FEE_SWEEP_SUFFIX)) {
    await validateFeeSweep(action, deps);
    return;
  }
  if (action.id.endsWith(REFUND_SUFFIX)) {
    await validateRefund(action, deps);
    return;
  }
  // PEG_OUT: dispatch by source-id SHAPE, not by action.remoteChain. The action is
  // coordinator-supplied (actionFromWire), so a remoteChain field on it is attacker-
  // controlled and dispatching on it would let a compromised coordinator route a real
  // burn to an unchecked branch. The id IS the source-event key, so its shape is the
  // honest discriminator: a Solana signature (base58, 64-byte) is unambiguous.
  if (looksLikeSolanaSignature(action.id)) {
    await validateSolanaPegOut(action, deps);
    return;
  }
  if (looksLikeTonTxHash(action.id)) {
    await validateTonPegOut(action, deps);
    return;
  }
  // Neither a Solana signature, a TON burn-tx hash, nor a FEE_SWEEP/REFUND child id.
  // FAIL CLOSED: refuse rather than sign without an independent check.
  throw new SourceMismatchError(
    `PEG_OUT ${action.id} matches no known source-id shape (Solana signature, TON tx hash, or FEE_SWEEP/REFUND child) — refusing to sign without an independent source check`,
  );
}

/**
 * Re-read the parent PEG_IN a child (FEE_SWEEP / REFUND) settles, from the operator's OWN
 * VIZ node, and return the deposit plus the re-derived parent canonical action. The child
 * id is the parent PEG_IN id ("<trxId>:<opIndex>") plus a suffix, so stripping the suffix
 * yields the parent key — which the operator resolves independently of the coordinator.
 */
async function reReadParentPegIn(
  action: CanonicalAction,
  suffix: string,
  deps: SourceValidatorDeps,
): Promise<{ deposit: VizDeposit; parent: CanonicalAction }> {
  const parentId = action.id.slice(0, -suffix.length);
  const sep = parentId.indexOf(":");
  const trxId = sep > 0 ? parentId.slice(0, sep) : "";
  // Strict opIndex: a lenient parseInt would accept trailing garbage ("0x" -> 0),
  // letting a compromised coordinator forge a distinct child id that still resolves
  // to the real parent deposit. Require a pure integer suffix.
  const opStr = parentId.slice(sep + 1);
  if (!trxId || !/^\d+$/.test(opStr)) {
    throw new SourceMismatchError(
      `malformed ${suffix} child id "${action.id}" (expected "<trxId>:<opIndex>${suffix}")`,
    );
  }
  const opIndex = Number.parseInt(opStr, 10);
  const deposit = await deps.vizChain.getDeposit(trxId, opIndex);
  if (!deposit) {
    throw new SourceMismatchError(
      `parent PEG_IN ${parentId} for ${action.id} not found or not yet irreversible on VIZ`,
    );
  }
  return { deposit, parent: canonicalPegIn(deposit) };
}

/**
 * FEE_SWEEP — the gateway sweeps the withheld peg-in fee to fees.gate. There is no remote
 * source event; instead the signer re-derives it from the PEG_IN it settles:
 *   - recipient MUST be the operator's OWN fees.gate account (config, never coordinator-fed),
 *     so a compromised coordinator can never redirect swept fees to an attacker;
 *   - amount MUST equal EXACTLY the `base` fee (pure function of the immutable gross), never
 *     a range. VG-04: the previous [base, base + activationSurcharge] tolerance let a
 *     compromised coordinator steer the sweep to the band maximum while pinning
 *     destProvisioned=true at mint (net = gross − base), so net + fee = gross + surcharge —
 *     the extra surcharge drained locked backing, repeatable per peg-in. The exact fee would
 *     need the mint-time `destProvisioned` bit, but the FEE_SWEEP is only spawned AFTER the
 *     mint has provisioned the destination, so no independent read (of either chain) can
 *     recover it at signing time. We therefore sweep ONLY the flag-free `base`; the activation
 *     surcharge (if any was withheld) is deliberately RETAINED on the gateway as backing
 *     surplus — fail-safe (over-backed, never under), and recon accounts for it as unswept
 *     fees. `base` is chain-independent (floor + bps), and both the dispatcher (spawn) and the
 *     signer (this check) derive it from `gross` alone, so the coordinator has no discretion;
 *   - the child digest MUST be bound to the re-derived parent digest ("<parentDigest>:fee").
 */
async function validateFeeSweep(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  const { deposit, parent } = await reReadParentPegIn(action, FEE_SWEEP_SUFFIX, deps);
  if (action.recipient !== deps.feesGateAccount) {
    throw new SourceMismatchError(
      `FEE_SWEEP recipient ${action.recipient} != operator's own fees.gate ${deps.feesGateAccount} (${action.id})`,
    );
  }
  if (action.digest !== `${parent.digest}${FEE_SWEEP_SUFFIX}`) {
    throw new SourceMismatchError(`FEE_SWEEP digest not bound to parent PEG_IN ${parent.id} (${action.id})`);
  }
  const base = baseFee(deposit.amountMilliViz, pegInFeePolicyFor(deps.fees, deposit.remoteChain));
  if (action.amountMilliViz !== base) {
    throw new SourceMismatchError(
      `FEE_SWEEP amount ${action.amountMilliViz} != exact derived base fee ${base} for ${action.id} ` +
        `(activation surcharge is never swept — retained as gateway backing surplus)`,
    );
  }
}

/**
 * REFUND — the gateway returns a stranded peg-in to its original VIZ sender (gross, no
 * fee). Fully independent: both the recipient (the deposit's sender) and the amount (the
 * gross deposit) come straight from the operator's own re-read of the source deposit, so
 * no tolerance is needed. The child digest MUST be bound to the parent ("<parentDigest>:refund").
 */
async function validateRefund(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  const { deposit, parent } = await reReadParentPegIn(action, REFUND_SUFFIX, deps);
  if (action.recipient !== deposit.from) {
    throw new SourceMismatchError(
      `REFUND recipient ${action.recipient} != deposit sender ${deposit.from} (${action.id})`,
    );
  }
  if (action.amountMilliViz !== deposit.amountMilliViz) {
    throw new SourceMismatchError(
      `REFUND amount ${action.amountMilliViz} != deposit gross ${deposit.amountMilliViz} (${action.id})`,
    );
  }
  if (action.digest !== `${parent.digest}${REFUND_SUFFIX}`) {
    throw new SourceMismatchError(`REFUND digest not bound to parent PEG_IN ${parent.id} (${action.id})`);
  }
}

async function validatePegIn(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  const sep = action.id.indexOf(":");
  const trxId = sep > 0 ? action.id.slice(0, sep) : "";
  // Strict opIndex (see reReadParentPegIn): reject any non-integer suffix so a
  // parse-equivalent but distinct id can never resolve to the real deposit.
  const opStr = action.id.slice(sep + 1);
  if (!trxId || !/^\d+$/.test(opStr)) {
    throw new SourceMismatchError(`malformed PEG_IN source id "${action.id}" (expected "<trxId>:<opIndex>")`);
  }
  const opIndex = Number.parseInt(opStr, 10);
  const deposit = await deps.vizChain.getDeposit(trxId, opIndex);
  if (!deposit) {
    throw new SourceMismatchError(`PEG_IN source ${action.id} not found or not yet irreversible on VIZ`);
  }
  assertSameAction(canonicalPegIn(deposit), action);
}

async function validateSolanaPegOut(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  if (!deps.depositProgramId) {
    throw new SourceMismatchError(`SOLANA_DEPOSIT_PROGRAM_ID not configured; cannot validate Solana peg-out ${action.id}`);
  }
  const burn = await deps.solanaChain.getBurn(action.id);
  if (!burn) {
    throw new SourceMismatchError(`PEG_OUT burn ${action.id} not found or not yet finalized on Solana`);
  }
  const rec = await deps.store.depositAddressBy(burn.from);
  if (!rec) {
    throw new SourceMismatchError(`no registered deposit address for burn source ${burn.from} (${action.id})`);
  }
  // Re-derive the deposit PDA from the VIZ account + public program ID. A tampered registry
  // row cannot redirect the release: the binding is recomputed independently, trustlessly.
  const expected = depositAddress(deps.depositProgramId, rec.vizAccount);
  if (expected !== burn.from) {
    throw new SourceMismatchError(
      `deposit-address binding mismatch for ${action.id}: derived ${expected} from "${rec.vizAccount}" != burn source ${burn.from}`,
    );
  }
  burn.homeDestination = rec.vizAccount;
  assertSameAction(canonicalPegOut(burn), action);
}

async function validateTonPegOut(action: CanonicalAction, deps: SourceValidatorDeps): Promise<void> {
  const burn = await deps.tonChain.getBurn(action.id);
  if (!burn) {
    throw new SourceMismatchError(`PEG_OUT burn ${action.id} not found or not yet final on TON`);
  }
  // Unlike Solana, TON needs no deposit-address registry: the VIZ recipient is the
  // on-chain transfer comment, which the operator's own node returns directly in the burn
  // (burn.homeDestination). The digest binds src + recipient + amount, so re-deriving the
  // canonical action from the re-read burn and asserting equality is the full check.
  assertSameAction(canonicalPegOut(burn), action);
}

/** Deep-equal the trust-critical fields; the digest is authoritative, the rest sharpen errors. */
function assertSameAction(derived: CanonicalAction, wire: CanonicalAction): void {
  // The id is the outbox idempotency key AND the on-chain memo (Solana). The digest
  // binds the SOURCE-DERIVED id, not the wire id, so without this check a compromised
  // coordinator could carry a distinct-but-parse-equivalent id (e.g. a trailing char
  // the deposit-key parser tolerates) past validation and drive a SECOND mint/release
  // for the same real source event. Assert the wire id equals the one we re-derived.
  if (derived.id !== wire.id) {
    throw new SourceMismatchError(`id ${wire.id} != source-derived ${derived.id}`);
  }
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
