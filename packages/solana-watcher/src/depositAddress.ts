import { createHmac } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

/**
 * Deterministic per-recipient Solana deposit addresses for peg-out (Variant A).
 *
 * Solana has no native memo and Phantom's send UI can't attach one, so we can't
 * route wVIZ -> VIZ by a memo. Instead each VIZ account gets its own deterministic
 * Solana deposit address: X = derive(MASTER_SEED, vizAccount). Funds arriving at X
 * are released to the VIZ account X was derived from — the ADDRESS is the routing
 * identity, so no memo is needed and the user can't forget it.
 *
 * Safe to expose openly: the VIZ account name is public and the release target is
 * bound to the derivation (not the sender), so a third party can only *gift* VIZ to
 * that account, never redirect it.
 *
 * The MASTER_SEED is a single hot key OUTSIDE the multisig (like fees.gate): it
 * cannot mint (that's the SPL multisig) or touch the VIZ backing (that's T-of-N),
 * so the peg's collateral is never at risk from it. But note the real blast radius:
 * a holder of MASTER_SEED can derive EVERY user's deposit private key and could
 * sweep in-flight peg-out wVIZ before the scanner burns it — i.e. theft of transient
 * user funds in transit, not just "burn". Treat it with HSM-grade key handling.
 *
 * Derivation uses HMAC-SHA512(MASTER_SEED, "...:vizAccount") -> 32-byte ed25519 seed
 * (node:crypto only — no extra deps), then Keypair.fromSeed.
 */

const DERIVATION_DOMAIN = "viz-gateway:peg-out:v1";

/** The deposit keypair for a VIZ account (the gateway holds this to burn/close). */
export function deriveDepositKeypair(masterSeed: string, vizAccount: string): Keypair {
  if (!masterSeed) throw new Error("MASTER_SEED not set; cannot derive deposit addresses");
  if (!vizAccount) throw new Error("vizAccount required");
  const seed = createHmac("sha512", masterSeed).update(`${DERIVATION_DOMAIN}:${vizAccount}`).digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

/** The deposit owner address (what the user sends wVIZ to). Stable per VIZ account. */
export function depositAddress(masterSeed: string, vizAccount: string): string {
  return deriveDepositKeypair(masterSeed, vizAccount).publicKey.toBase58();
}

/** The wVIZ ATA of the deposit address (what the scanner watches). */
export function depositAta(masterSeed: string, vizAccount: string, mint: string): string {
  const owner = deriveDepositKeypair(masterSeed, vizAccount).publicKey;
  return getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID).toBase58();
}
