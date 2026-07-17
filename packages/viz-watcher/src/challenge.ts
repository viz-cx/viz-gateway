import { PrivateKey, Signature } from "viz-js-lib/lib/auth/ecc";

/**
 * Registration challenge (signer self-registration). The signer proves it holds
 * an operator's VIZ key by signing this message; the coordinator recovers the key
 * and matches it to federation.json. The domain prefix is defense-in-depth so this
 * signature can never be mistaken for a VIZ transaction signature (which signs over
 * chain_id ++ serialized-trx bytes — a disjoint buffer).
 */
const DOMAIN = "viz-gateway-register";

export function challengeMessage(operatorId: string, url: string, nonce: string, vizPerTon?: number): string {
  const base = `${DOMAIN}\n${operatorId}\n${url}\n${nonce}`;
  // Append the price quote ONLY when present, so a legacy signer that sends no quote
  // signs (and the coordinator verifies) the exact original message — back-compatible.
  return vizPerTon === undefined ? base : `${base}\n${vizPerTon}`;
}

/** Derive the VIZ public key ("VIZ…", matching key_auths) that a WIF signs for. */
export function pubkeyFromWif(wif: string): string {
  if (!wif) throw new Error("VIZ signing key (WIF) not set; cannot derive public key");
  return PrivateKey.fromWif(wif).toPublicKey().toString();
}

/** Sign the challenge with the operator's VIZ WIF; returns a hex signature. */
export function signChallenge(operatorId: string, url: string, nonce: string, wif: string, vizPerTon?: number): string {
  if (!wif) throw new Error("VIZ signing key (WIF) not set; cannot sign registration challenge");
  const buf = Buffer.from(challengeMessage(operatorId, url, nonce, vizPerTon), "utf8");
  return Signature.signBuffer(buf, PrivateKey.fromWif(wif)).toHex();
}

/** Recover the VIZ pubkey ("VIZ…") that signed the challenge. Throws on garbage input. */
export function recoverChallengeSigner(operatorId: string, url: string, nonce: string, sigHex: string, vizPerTon?: number): string {
  const buf = Buffer.from(challengeMessage(operatorId, url, nonce, vizPerTon), "utf8");
  return Signature.fromHex(sigHex).recoverPublicKeyFromBuffer(buf).toString();
}
