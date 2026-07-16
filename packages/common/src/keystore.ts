import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

/**
 * Local at-rest key encryption for the operator's raw secret material.
 *
 * Custody decision (2026-07-06, see AUDIT.md §8): keys stay on each operator's
 * OWN machine — the M-of-N federation is the custody control, HSM/KMS is not
 * planned. This module closes the narrower gap that leaves: plaintext WIFs /
 * mnemonics / secrets sitting on disk or in `.env` files. It seals them into a
 * single passphrase-protected envelope so nothing sensitive is at rest in the
 * clear.
 *
 * HONEST LIMIT: this protects secrets AT REST only. Once decrypted the values
 * live in the Node process as ordinary strings/bytes, which cannot be reliably
 * zeroized — in-memory exposure of a running signer is unchanged and remains in
 * scope for review. The threshold still bounds a single-box compromise.
 *
 * Envelope: AES-256-GCM over a JSON blob of the present secrets, key derived
 * from the passphrase with scrypt. Pure `node:crypto` — deliberately NO OS
 * keychain / keytar / libsecret, so the same file works headless (docker) and
 * on an operator laptop alike. The GCM auth tag + a fixed AAD detect any
 * tampering or a wrong passphrase (both surface as a decryption failure).
 */

/** The secret fields a keystore can carry. All optional — only seal what an operator holds. */
export interface KeystoreSecrets {
  /** VIZ signing WIF (base58 private key). */
  vizSigningWif?: string;
  /** TON/GRAM signer BIP-39 mnemonic (space-separated words). */
  gramSignerMnemonic?: string;
  /** Solana signer secret in solana-keygen JSON byte-array form, e.g. "[12,34,...]". */
  solanaSignerSecret?: string;
  /**
   * VIZ memo private keys (WIFs), keyed by remote chain id (e.g. "GRAM"), used to
   * decrypt `#`-encrypted peg-in memos addressed to that chain's gate account.
   * Non-fund-controlling: a leak costs destination privacy, not custody (AUDIT.md §8).
   * Must be identical across all operators or encrypted peg-ins liveness-stall — see
   * resolveMemoDestination.
   */
  vizMemoWifs?: Record<string, string>;
}

/** scrypt cost parameters, persisted in the file so `open` uses the same ones `seal` chose. */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/** The on-disk sealed keystore. All binary fields are base64. */
export interface Keystore {
  v: 1;
  kdf: "scrypt";
  kdfParams: KdfParams;
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * scrypt defaults. N=2^17 with r=8,p=1 needs ~256 MB of scratch (128*N*r*2), well
 * above scrypt's 32 MB default maxmem, so we pass an explicit maxmem below. This is
 * a one-shot seal/unseal at operator setup / service start, never a hot path, so a
 * deliberately heavy KDF is the right trade.
 */
const DEFAULT_KDF: KdfParams = { N: 1 << 17, r: 8, p: 1, keyLen: 32 };

/** AAD binds the envelope version so a downgrade/format swap can't slip past the auth tag. */
const AAD = Buffer.from("viz-gateway-keystore-v1");

function scryptMaxmem(params: KdfParams): number {
  // scrypt scratch ≈ 128 * N * r bytes; double it for headroom over node's internal accounting.
  return 128 * params.N * params.r * 2;
}

function deriveKey(passphrase: string, salt: Buffer, params: KdfParams): Buffer {
  if (passphrase.length === 0) throw new Error("keystore: passphrase must not be empty");
  return scryptSync(Buffer.from(passphrase, "utf8"), salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: scryptMaxmem(params),
  });
}

/** Encrypt the present secrets under `passphrase`. Returns the JSON-serializable envelope. */
export function sealKeystore(
  secrets: KeystoreSecrets,
  passphrase: string,
  kdfParams: KdfParams = DEFAULT_KDF,
): Keystore {
  const present: KeystoreSecrets = {};
  if (secrets.vizSigningWif) present.vizSigningWif = secrets.vizSigningWif;
  if (secrets.gramSignerMnemonic) present.gramSignerMnemonic = secrets.gramSignerMnemonic;
  if (secrets.solanaSignerSecret) present.solanaSignerSecret = secrets.solanaSignerSecret;
  if (secrets.vizMemoWifs && Object.keys(secrets.vizMemoWifs).length > 0) {
    // Copy only non-empty string entries so an empty/garbage map can't seal blank keys.
    const wifs: Record<string, string> = {};
    for (const [chain, wif] of Object.entries(secrets.vizMemoWifs)) {
      if (typeof wif === "string" && wif) wifs[chain] = wif;
    }
    if (Object.keys(wifs).length > 0) present.vizMemoWifs = wifs;
  }
  if (Object.keys(present).length === 0) {
    throw new Error("keystore: nothing to seal — no secret fields provided");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const key = deriveKey(passphrase, salt, kdfParams);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(present), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    v: 1,
    kdf: "scrypt",
    kdfParams,
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function requireString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new Error(`keystore: malformed — missing "${k}"`);
  return v;
}

/**
 * Decrypt a keystore. Throws on a wrong passphrase, a tampered file, or an
 * unsupported version — a wrong passphrase and a tampered ciphertext are
 * indistinguishable here (both fail the GCM auth check), which is intended.
 */
export function openKeystore(ks: unknown, passphrase: string): KeystoreSecrets {
  const o = ks as Record<string, unknown>;
  if (o["v"] !== 1) throw new Error(`keystore: unsupported version ${String(o["v"])}`);
  if (o["kdf"] !== "scrypt") throw new Error(`keystore: unsupported kdf ${String(o["kdf"])}`);
  if (o["cipher"] !== "aes-256-gcm") throw new Error(`keystore: unsupported cipher ${String(o["cipher"])}`);

  const kp = o["kdfParams"] as Record<string, unknown> | undefined;
  if (!kp) throw new Error("keystore: malformed — missing kdfParams");
  const params: KdfParams = {
    N: Number(kp["N"]),
    r: Number(kp["r"]),
    p: Number(kp["p"]),
    keyLen: Number(kp["keyLen"]),
  };
  if (![params.N, params.r, params.p, params.keyLen].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("keystore: malformed kdfParams");
  }

  const salt = Buffer.from(requireString(o, "salt"), "base64");
  const iv = Buffer.from(requireString(o, "iv"), "base64");
  const authTag = Buffer.from(requireString(o, "authTag"), "base64");
  const ciphertext = Buffer.from(requireString(o, "ciphertext"), "base64");

  const key = deriveKey(passphrase, salt, params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure — wrong passphrase or tampered file. Do not leak which.
    throw new Error("keystore: decryption failed (wrong passphrase or corrupted file)");
  }

  const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  const out: KeystoreSecrets = {};
  if (typeof parsed["vizSigningWif"] === "string") out.vizSigningWif = parsed["vizSigningWif"];
  if (typeof parsed["gramSignerMnemonic"] === "string") out.gramSignerMnemonic = parsed["gramSignerMnemonic"];
  if (typeof parsed["solanaSignerSecret"] === "string") out.solanaSignerSecret = parsed["solanaSignerSecret"];
  if (parsed["vizMemoWifs"] && typeof parsed["vizMemoWifs"] === "object") {
    const wifs: Record<string, string> = {};
    for (const [chain, wif] of Object.entries(parsed["vizMemoWifs"] as Record<string, unknown>)) {
      if (typeof wif === "string" && wif) wifs[chain] = wif;
    }
    if (Object.keys(wifs).length > 0) out.vizMemoWifs = wifs;
  }
  return out;
}

/** Constant-time string compare, exported for the CLI's seal-confirmation check. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
