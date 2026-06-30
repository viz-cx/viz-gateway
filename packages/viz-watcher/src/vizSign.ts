import viz, { type VizTransaction } from "viz-js-lib";
import { transaction as txSerializer } from "viz-js-lib/lib/auth/serializer/src/operations";
import { sha256 } from "viz-js-lib/lib/auth/ecc/src/hash";
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
