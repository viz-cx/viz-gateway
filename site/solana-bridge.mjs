// Pure, dependency-free helpers for the Solana bridge app (solana.js).
// Mirrors pegout.mjs: browser + Node (verify spike) share one source of truth.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decoded byte length of a base58 string, or -1 if it isn't base58.
 * Enough to validate a Solana pubkey (= exactly 32 bytes) without a library.
 */
export function base58DecodedLength(s) {
  if (typeof s !== "string" || s.length === 0) return -1;
  let n = 0n;
  for (const c of s) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) return -1;
    n = n * 58n + BigInt(i);
  }
  let len = 0;
  for (let m = n; m > 0n; m >>= 8n) len++;
  for (const c of s) {
    if (c !== "1") break;
    len++; // each leading '1' is a leading zero byte
  }
  return len;
}

/**
 * Stricter than the gateway's own 32-44-char regex: requires an exact 32-byte
 * decode, so a truncated/typo'd paste is caught here instead of costing the
 * user the refund fee after a failed mint.
 */
export function isValidSolanaAddress(s) {
  return base58DecodedLength((s ?? "").trim()) === 32;
}

/**
 * Solana Pay transfer-request URL (https://docs.solanapay.com/spec) for sending
 * `amount` (UI units string, e.g. "30.5") of the SPL token `mint` to `recipient`.
 * Amount is optional — wallets prompt for it when absent.
 */
export function solanaPayUrl({ recipient, mint, amount }) {
  let url = `solana:${recipient}?spl-token=${mint}`;
  if (amount && /^\d+(\.\d+)?$/.test(amount) && parseFloat(amount) > 0) url += `&amount=${amount}`;
  return url;
}
