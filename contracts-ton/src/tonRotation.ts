import { createHash } from "node:crypto";
import { Address, type Cell } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { Multisig, type UpdateRequest } from "./wrappers/Multisig";
import type { OperatorRef, RotationProposal } from "@gateway/common";

/**
 * An operator's multisig-v2 signer address = WalletContractV4(workchain 0) over
 * their ed25519 tonPubkey. Operators MUST use a V4 wallet on workchain 0 to be a
 * valid signer (matches contracts-ton/src/wallet.ts deployer derivation).
 */
export function tonSignerAddress(tonPubkeyHex: string): Address {
  const publicKey = Buffer.from(tonPubkeyHex, "hex");
  if (publicKey.length !== 32) throw new Error(`tonPubkey must be 32-byte ed25519 hex: ${tonPubkeyHex}`);
  return WalletContractV4.create({ workchain: 0, publicKey }).address;
}

/** The `update_multisig_params` action setting the new signer set + threshold. */
export function buildUpdateAction(operators: OperatorRef[], newThreshold: number): UpdateRequest {
  if (newThreshold < 1 || newThreshold > operators.length) {
    throw new Error(`threshold ${newThreshold} must be in 1..${operators.length}`);
  }
  // Signer index order = operators array order (kept consistent across submit/approve).
  const signers = operators.map((o) => tonSignerAddress(o.tonPubkey));
  const addrs = signers.map((a) => a.toString());
  if (new Set(addrs).size !== addrs.length) {
    throw new Error("duplicate tonPubkey in operator set");
  }
  return { type: "update", threshold: newThreshold, signers, proposers: [] };
}

/** Deterministic packed order cell for the rotation (one update action). */
export function packRotationOrder(operators: OperatorRef[], newThreshold: number): Cell {
  return Multisig.packOrder([buildUpdateAction(operators, newThreshold)]);
}

/**
 * Trust-critical: rebuild the expected packed order from the proposal and assert
 * the on-chain order's action cell is byte-identical, so an operator never
 * approves an order other than the one the proposal claims (the TON analogue of
 * the VIZ byte-identity check).
 */
export function validateTonOrder(
  onchainOrder: Cell,
  proposal: Pick<RotationProposal, "newOperators" | "newThreshold">,
): void {
  const expected = packRotationOrder(proposal.newOperators, proposal.newThreshold);
  if (!onchainOrder.equals(expected)) {
    throw new Error("TON order action does not match the proposal (tampered or stale)");
  }
}

/** Canonical, order-independent hash of a signer set + threshold. */
export function tonSignerSetHash(signers: Address[], threshold: number): string {
  const canonical = JSON.stringify({
    threshold,
    signers: signers.map((a) => a.toString()).sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Order-independent equality of two signer sets (ignores threshold — use tonSignerSetHash when threshold must also match). */
export function sameSignerSet(a: Address[], b: Address[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map((x) => x.toString()).sort();
  const sb = b.map((x) => x.toString()).sort();
  return sa.every((v, i) => v === sb[i]);
}
