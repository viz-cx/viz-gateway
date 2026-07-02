/**
 * Pure request-resolution for the deposit-address lookup (peg-out Variant A),
 * factored out of the HTTP server in `lookup.ts` so it can be tested offline.
 *
 * Two gates, in order:
 *   1. format pre-filter (`VIZ_ACCOUNT_RE`) — a cheap reject before any RPC;
 *   2. on-chain existence (`accountExists`) — the real gate. wVIZ sent to a
 *      deposit address for a typo'd/non-existent VIZ account would be burned on
 *      release with no valid target and no refund (peg-out never refunds), so a
 *      non-existent account must never be issued/registered an address.
 *
 * The regex is deliberately loose (it lets e.g. "a." or "a..b" through); it only
 * screens the obvious junk to save an RPC round-trip. Correctness rests on the
 * existence gate, not the regex.
 */

/** VIZ/Graphene account-name charset: leading letter + 1..31 of [a-z0-9.-] (len 2..32). */
export const VIZ_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,31}$/;

/** Trim + lowercase, then format-check. Returns the normalized name or null. */
export function normalizeVizAccount(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return VIZ_ACCOUNT_RE.test(v) ? v : null;
}

export type LookupResolution =
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 200; vizAccount: string; address: string; ata: string };

export interface LookupDeps {
  /** On-chain existence check (VizChain.accountExists — a get_accounts read). */
  accountExists: (name: string) => Promise<boolean>;
  depositAddress: (vizAccount: string) => string;
  depositAta: (vizAccount: string) => string;
}

/**
 * Resolve a lookup request to a decision. On `200` the caller registers
 * {address, ata} and returns them; a thrown `accountExists` (VIZ node down)
 * propagates so the caller can fail closed (500) rather than issue unverified.
 */
export async function resolveDepositAddress(
  raw: string | null | undefined,
  deps: LookupDeps,
): Promise<LookupResolution> {
  const vizAccount = normalizeVizAccount(raw);
  if (!vizAccount) return { status: 400, body: { error: "invalid viz_account" } };
  if (!(await deps.accountExists(vizAccount))) {
    return { status: 404, body: { error: "viz_account does not exist on VIZ" } };
  }
  return {
    status: 200,
    vizAccount,
    address: deps.depositAddress(vizAccount),
    ata: deps.depositAta(vizAccount),
  };
}
