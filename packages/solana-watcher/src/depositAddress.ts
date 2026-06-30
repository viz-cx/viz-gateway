import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";

/**
 * Deterministic per-recipient Solana deposit addresses for peg-out (Variant A),
 * using ADDITIVE ed25519 derivation so the address can be re-derived from a PUBLIC
 * master key alone (F2).
 *
 * Solana has no native memo Phantom can attach, so we route wVIZ -> VIZ by ADDRESS:
 * each VIZ account gets its own deterministic deposit address X; funds arriving at X
 * are released to the VIZ account X was derived from. The binding (address -> VIZ
 * account) is the routing identity.
 *
 * F2 needs every signer to INDEPENDENTLY re-derive X to verify a peg-out release
 * target — but handing the secret master seed to all N operators would multiply the
 * highest-blast-radius key (a seed holder can sweep every user's in-transit funds).
 * So derivation is split:
 *
 *   childPub   = masterPub  + tweak(masterPub, vizAccount)·G    (signers: PUBLIC only)
 *   childScalar= masterScalar + tweak(masterPub, vizAccount)    (scanner/sweeper only)
 *
 * Both yield the same point => the same address. Signers get DEPOSIT_MASTER_PUB
 * (safe to publish); only the single sweep service holds DEPOSIT_MASTER_SEED.
 *
 * The child private value is a raw SCALAR (not a seed), so it cannot be wrapped in a
 * stock @solana/web3.js Keypair (those are seed-based; seed->scalar via SHA-512+clamp
 * is not additively homomorphic). The sweeper therefore signs burns with the explicit
 * scalar via `deriveDepositSigner(...).signMessage` (RFC 8032 ed25519, deterministic
 * secret nonce). Offline-verified in tools/signer-f2-spike.cjs: a scalar-signed message
 * verifies under ed25519.verify against the publicly-derived address.
 */

const Point = ed25519.Point;
const L = Point.Fn.ORDER; // ed25519 prime-order subgroup order

const DERIVATION_DOMAIN = "viz-gateway:peg-out:v2"; // v2 = additive ed25519 (was HMAC v1)
const NONCE_DOMAIN = "viz-gateway:peg-out:nonce:v2";

// --- low-level scalar/byte helpers (little-endian, per RFC 8032) ----------------

function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

/** Little-endian bytes -> bigint. */
function leToBigInt(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i] ?? 0);
  return r;
}

/** bigint -> 32-byte little-endian (the ed25519 scalar S encoding). */
function bigIntToLe32(n: bigint): Uint8Array {
  const o = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}

/** ed25519 clamp of the low 32 bytes of SHA-512(seed) -> the master scalar's bits. */
function clamp(h: Uint8Array): Uint8Array {
  const c = Uint8Array.from(h.subarray(0, 32));
  c[0] = (c[0] ?? 0) & 248;
  c[31] = ((c[31] ?? 0) & 127) | 64;
  return c;
}

/**
 * Master signing scalar from the seed, reduced mod L for additive arithmetic.
 *
 * NOTE: stock ed25519 (and @solana/web3.js Keypair) does NOT reduce the clamped scalar
 * mod L — it multiplies the full clamped value by G. We reduce here so the scalar adds
 * homomorphically with the tweak (childScalar = masterScalar + tweak). A consequence:
 * `masterPubFromSeed(seed)` is intentionally NOT the stock Keypair pubkey for that seed,
 * and the derived child scalar is a raw scalar — never load it as a stock Keypair (it has
 * no seed preimage). The master key is only ever a derivation base, never a funds account.
 */
function masterScalar(masterSeed: string): bigint {
  if (!masterSeed) throw new Error("DEPOSIT_MASTER_SEED not set; cannot derive deposit keys");
  return leToBigInt(clamp(sha512(utf8(masterSeed)))) % L;
}

/** Deterministic per-account tweak scalar t = SHA-512(masterPub || DOMAIN || viz) mod L. */
function tweakScalar(masterPubBytes: Uint8Array, vizAccount: string): bigint {
  if (!vizAccount) throw new Error("vizAccount required");
  return leToBigInt(sha512(masterPubBytes, utf8(DERIVATION_DOMAIN), utf8(vizAccount))) % L;
}

// --- public derivation (SIGNER side — needs masterPub only) ---------------------

/** Derive the base58 master public key from the seed (operators configure this). */
export function masterPubFromSeed(masterSeed: string): string {
  const pub = Point.BASE.multiply(masterScalar(masterSeed)).toBytes();
  return new PublicKey(Buffer.from(pub)).toBase58();
}

/** The deposit owner PublicKey, derived from the PUBLIC master key alone. */
export function depositPubFromMasterPub(masterPub: string, vizAccount: string): PublicKey {
  const masterPubBytes = new PublicKey(masterPub).toBytes();
  const child = Point.fromHex(masterPubBytes).add(Point.BASE.multiply(tweakScalar(masterPubBytes, vizAccount)));
  return new PublicKey(Buffer.from(child.toBytes()));
}

/** Base58 deposit owner address from the public master key (signer binding check). */
export function depositAddressFromMasterPub(masterPub: string, vizAccount: string): string {
  return depositPubFromMasterPub(masterPub, vizAccount).toBase58();
}

// --- secret derivation (SCANNER / SWEEPER side — needs the seed) ----------------

/**
 * A deposit signer: the publicly-known owner address plus the ability to sign a
 * message with the additively-derived scalar (the sweeper's burn authority). The
 * scalar never leaves this closure.
 */
export interface DepositSigner {
  readonly publicKey: PublicKey;
  /** RFC 8032 ed25519 signature over `message` using the child scalar (64 bytes). */
  signMessage(message: Uint8Array): Uint8Array;
}

/** Derive the deposit signer for a VIZ account from the secret master seed. */
export function deriveDepositSigner(masterSeed: string, vizAccount: string): DepositSigner {
  const a = masterScalar(masterSeed);
  const masterPubBytes = Point.BASE.multiply(a).toBytes();
  const t = tweakScalar(masterPubBytes, vizAccount);
  const scalar = (a + t) % L;
  const pubBytes = Point.BASE.multiply(scalar).toBytes();
  const publicKey = new PublicKey(Buffer.from(pubBytes));
  // Secret, deterministic nonce prefix (the RFC 8032 "prefix"): bound to seed+account.
  const prefix = sha512(utf8(NONCE_DOMAIN), utf8(masterSeed), utf8(vizAccount)).subarray(0, 32);
  return {
    publicKey,
    signMessage(message: Uint8Array): Uint8Array {
      const r = leToBigInt(sha512(prefix, message)) % L;
      const R = Point.BASE.multiply(r).toBytes();
      const k = leToBigInt(sha512(R, pubBytes, message)) % L;
      const S = (r + k * scalar) % L;
      return new Uint8Array(Buffer.concat([Buffer.from(R), Buffer.from(bigIntToLe32(S))]));
    },
  };
}

// --- base58 address wrappers (lookup service + scanner) -------------------------

/**
 * The deposit owner PublicKey from the seed, WITHOUT building the signing closure
 * (no nonce-prefix hash) — address-only lookups don't need spend authority.
 */
function depositPubFromSeed(masterSeed: string, vizAccount: string): PublicKey {
  const a = masterScalar(masterSeed);
  const masterPubBytes = Point.BASE.multiply(a).toBytes();
  const child = Point.BASE.multiply((a + tweakScalar(masterPubBytes, vizAccount)) % L);
  return new PublicKey(Buffer.from(child.toBytes()));
}

/** The deposit owner address (what the user sends wVIZ to). Stable per VIZ account. */
export function depositAddress(masterSeed: string, vizAccount: string): string {
  return depositPubFromSeed(masterSeed, vizAccount).toBase58();
}

/** The wVIZ ATA of the deposit address (what the scanner watches). */
export function depositAta(masterSeed: string, vizAccount: string, mint: string): string {
  const owner = depositPubFromSeed(masterSeed, vizAccount);
  return getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID).toBase58();
}
