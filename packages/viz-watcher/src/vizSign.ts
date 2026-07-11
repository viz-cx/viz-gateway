import viz, { type VizTransaction } from "viz-js-lib";
import { transaction as txSerializer } from "viz-js-lib/lib/auth/serializer/src/operations";
import { sha256 } from "viz-js-lib/lib/auth/ecc/src/hash";
import { Signature } from "viz-js-lib/lib/auth/ecc";
import type { VizReleaseProposal } from "@gateway/common";

/**
 * VIZ release signing (the peg-out write path).
 *
 * All operators must sign byte-identical bytes for their secp256k1 signatures
 * to merge into one multisig transaction, so the transaction is reconstructed
 * deterministically from the shared proposal. `auth.signTransaction` signs over
 * chain_id + toBuffer(trx) and appends to `signatures`; the array is treated as
 * an unordered set (verified in tools/viz-multisig-spike.cjs).
 */

/** Reconstruct the exact unsigned transfer transaction from a proposal. */
export function buildReleaseTx(p: VizReleaseProposal): VizTransaction {
  return {
    ref_block_num: p.refBlockNum,
    ref_block_prefix: p.refBlockPrefix,
    expiration: p.expiration,
    operations: [["transfer", { from: p.from, to: p.to, amount: p.amount, memo: p.memo }]],
    extensions: [],
  };
}

/**
 * The deterministic VIZ transaction id for a release proposal: the standard graphene
 * trx id = first 20 bytes of sha256 of the serialized UNSIGNED transaction. It depends
 * only on TaPoS + operations (NOT the signatures), so the coordinator can compute and
 * persist it BEFORE broadcasting. Recovery then confirms a release by its exact id via
 * getTransaction(txid) instead of a bounded memo history scan — closing the residual
 * double-release window on the VIZ side (VIZ transfers are not nonce-deduped on-chain).
 */
export function releaseTxId(p: VizReleaseProposal): string {
  return sha256(txSerializer.toBuffer(buildReleaseTx(p))).slice(0, 20).toString("hex");
}

/** Produce this operator's partial signature (hex) over the proposal's tx. */
export function signRelease(p: VizReleaseProposal, wif: string): string {
  if (!wif) throw new Error("VIZ signing key (WIF) not set; refusing to sign");
  const signed = viz.auth.signTransaction(buildReleaseTx(p), [wif]);
  const sig = signed.signatures?.[0];
  if (!sig) throw new Error("signTransaction produced no signature");
  return sig;
}

/** The minimal shape of a VIZ active authority this module needs (equal to Account.active_authority). */
export interface VizAuthority {
  weight_threshold: number;
  key_auths: [string, number][];
}

/**
 * Recover the VIZ public key that produced a release signature. Operators sign over
 * sha256(chain_id ++ toBuffer(trx)) and the recovery param is encoded in the signature,
 * so the exact same buffer reconstructed from the proposal recovers the signer's key
 * (e.g. "VIZ65QRp…"). Lets broadcastRelease attribute each collected signature to a key.
 */
export function recoverReleaseSigner(p: VizReleaseProposal, signatureHex: string): string {
  const cid = Buffer.from(String(viz.config.get("chain_id")), "hex");
  const buf = txSerializer.toBuffer(buildReleaseTx(p));
  return Signature.fromHex(signatureHex)
    .recoverPublicKeyFromBuffer(Buffer.concat([cid, buf]))
    .toString();
}

/**
 * Pick a MINIMAL satisfying subset of the collected signatures for the backing account's
 * active authority. The federation can collect MORE approvals than the VIZ account needs
 * (its own threshold, or the higher-threshold remote minter authority the same operators
 * sign) — and VIZ/graphene rejects a transfer carrying a signature beyond its minimal set
 * ("irrelevant signature included"), an apply-time rejection an async broadcast never
 * surfaces (the release silently never lands). So we attribute each signature to a key via
 * secp256k1 recovery, keep only those in key_auths (no trust in collection order), skip
 * duplicates, and accumulate distinct-key weights until weight_threshold is reached —
 * stopping exactly there so no extra signature rides along. Fail closed: throw if the
 * relevant signatures can't reach the threshold rather than wire a sub-threshold transfer.
 *
 * Robust to federation/authority divergence during a rotation window (an operator whose key
 * is not — or not yet — in the account's active authority is simply ignored), which a blind
 * slice(0, weight_threshold) of the collected order is not.
 */
export function selectAuthoritySignatures(
  p: VizReleaseProposal,
  signatures: string[],
  authority: VizAuthority,
): string[] {
  const weightOf = new Map(authority.key_auths.map(([k, w]) => [k, w]));
  const chosen: string[] = [];
  const usedKeys = new Set<string>();
  let weight = 0;
  for (const sig of signatures) {
    if (weight >= authority.weight_threshold) break; // minimal set reached — take no more
    let key: string;
    try {
      key = recoverReleaseSigner(p, sig);
    } catch {
      continue; // unrecoverable/garbage signature — not attributable to any key
    }
    const w = weightOf.get(key);
    if (w === undefined || usedKeys.has(key)) continue; // not in this authority, or a duplicate
    usedKeys.add(key);
    chosen.push(sig);
    weight += w;
  }
  if (weight < authority.weight_threshold) {
    throw new Error(
      `release ${p.from}: relevant signatures reach weight ${weight}, active authority needs ${authority.weight_threshold}`,
    );
  }
  return chosen;
}
