import viz from "viz-js-lib";

/**
 * Resolve a raw VIZ transfer memo to the plaintext remote destination address.
 *
 * VIZ memos may be encrypted to the receiving account's memo key (Graphene
 * convention: an encrypted memo is base58 text prefixed with '#'). When we hold
 * the gate account's memo private key we decrypt it; a plaintext memo — and any
 * memo we cannot read — is returned/handled without a key, so this is a safe
 * drop-in ahead of the existing address validation.
 *
 * TRUST-CRITICAL / CONSENSUS: decryption is deterministic (AES; the nonce is
 * carried inside the blob), so every operator holding the SAME memo key resolves
 * the SAME plaintext and therefore the SAME canonical digest (see canonicalPegIn).
 * An operator MISSING the key resolves "" (invalid) and refuses to sign — a
 * liveness stall that ends in auto-refund, never a wrong-destination mint. The
 * memo key must therefore be present on ALL signers or on none, exactly like the
 * shared fee config invariant documented in canonical.ts.
 *
 * FAIL-CLOSED: a malformed blob or a wrong key throws inside viz.memo.decode; we
 * swallow it and return "" so the deposit is flagged destinationValid=false and
 * auto-refunded to the sender rather than minted to a wrong/garbage address.
 *
 * @param rawMemo  the transfer memo, already trimmed by the caller
 * @param memoWif  the gate account's memo WIF, or undefined if none is configured
 * @returns the resolved plaintext destination, or "" if it cannot be resolved
 */
export function resolveMemoDestination(rawMemo: string, memoWif?: string): string {
  // Plaintext memo (the historical case): no key needed, pass straight through.
  if (!rawMemo.startsWith("#")) return rawMemo;
  // Encrypted memo but we hold no key for this account: cannot read it -> refund.
  if (!memoWif) return "";
  try {
    const decoded = viz.memo.decode(memoWif, rawMemo);
    // viz-js-lib preserves the plaintext's own leading '#' in the decode output
    // (it strips only the ciphertext marker), so remove one leading '#' here.
    return (decoded.startsWith("#") ? decoded.slice(1) : decoded).trim();
  } catch {
    // Malformed ciphertext or wrong/foreign memo key -> treat as no valid destination.
    return "";
  }
}
