import type { OperatorRef } from "@gateway/common";
import { pubkeyFromWif } from "@gateway/viz-watcher/dist/challenge";

/**
 * Derive this box's operator id from its VIZ signing key, not a hand-set label. The
 * key's public key is looked up in the federation manifest to find which slot it is
 * labeled for — the same key-anchored fact the coordinator enforces at registration
 * (packages/coordinator/src/registry.ts), computed locally so an operator never has to
 * know or type their slot. Under the intended custody model each operator holds only
 * their own private key, so the key IS the identity; asking for OPERATOR_ID as well is
 * redundant.
 *
 * OPERATOR_ID stays supported but optional + advisory: if set and it disagrees with the
 * key's slot, we warn and trust the key (the cryptographic fact wins over the typed
 * label). If the key is not in the manifest at all, the box could never register, so we
 * fail fast here with a clear message instead of at the first rejected challenge.
 */
export function resolveOperatorId(
  signingWif: string,
  operators: OperatorRef[],
  suppliedId?: string,
  warn: (msg: string) => void = (m) => console.warn(m),
): string {
  const pubkey = pubkeyFromWif(signingWif);
  const match = operators.find((o) => o.vizPubkey === pubkey);
  if (!match) {
    throw new Error(
      `VIZ signing key (${pubkey}) is not in federation.json's operator set — this box cannot ` +
        `register. Seal the correct operator VIZ key into FED_KEYSTORE, or fix the manifest's vizPubkey.`,
    );
  }
  const supplied = suppliedId?.trim();
  if (supplied && supplied !== match.id) {
    warn(
      `[signer] OPERATOR_ID='${supplied}' disagrees with this box's VIZ key, which is labeled ` +
        `'${match.id}' in federation.json — using '${match.id}' (the key is authoritative). ` +
        `Unset OPERATOR_ID to silence this.`,
    );
  }
  return match.id;
}
