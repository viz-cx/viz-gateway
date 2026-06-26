import type { CapDecision } from "@gateway/common";

/**
 * Decision on whether a deposit-address peg-out may proceed to the irreversible
 * burn. Pure (no I/O) so it is unit-testable offline.
 *
 * A burned-but-unreleasable peg-out is permanent user loss (no wVIZ, and PEG_OUT
 * never refunds), so the burn is gated on BOTH the rolling caps AND the release
 * target actually existing on VIZ. On any failure the row parks in HELD and the
 * wVIZ stays in the deposit ATA, recoverable.
 */
export type PegOutGuard =
  | { burn: true }
  | { burn: false; reason: string; pause?: string };

export function guardPegOut(cap: CapDecision, accountExists: boolean): PegOutGuard {
  if (!cap.ok) {
    return {
      burn: false,
      reason: cap.reason,
      // OVER_24H trips the shared, cross-process pause (the whole gateway halts).
      pause: cap.reason === "OVER_24H" ? "Solana peg-out 24h cap exceeded" : undefined,
    };
  }
  if (!accountExists) {
    return { burn: false, reason: "VIZ account does not exist" };
  }
  return { burn: true };
}

/**
 * What to do with a peg-out row stranded in SEEN (a crash between burn and the
 * QUEUED hand-off). The scanner checkpoints the burn signature onto the row (as
 * `txid`) right after burning, so recovery is decidable from whether that
 * signature landed:
 *   - no checkpoint        -> crashed at/before burn; can't auto-decide -> ALERT
 *   - checkpoint landed     -> burn happened; hand to the dispatcher    -> REQUEUE
 *   - checkpoint not landed -> burn never landed; drop the claim, retry -> RELEASE
 * Pure (no I/O) so it is unit-testable offline.
 */
export type SeenRecovery = "ALERT" | "REQUEUE" | "RELEASE";

export function classifySeenRecovery(hasBurnCheckpoint: boolean, burnLanded: boolean): SeenRecovery {
  if (!hasBurnCheckpoint) return "ALERT";
  return burnLanded ? "REQUEUE" : "RELEASE";
}
