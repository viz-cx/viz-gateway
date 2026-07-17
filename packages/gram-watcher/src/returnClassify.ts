/** Why a peg-out cannot be released to its memo destination ("" = usable, release proceeds). */
export type ReturnReason = "" | "RETURN_INVALID_DEST";

/**
 * Decide whether a peg-out's VIZ (home) destination is usable. The memo names a VIZ account;
 * a single existence check uniformly covers empty (accountExists("") is false), malformed, and
 * non-existent names (all resolve to no account). Returns "RETURN_INVALID_DEST" when the wVIZ
 * must be auto-returned to the sender, "" when the native-VIZ release can proceed.
 *
 * NOTE: this is a routing HINT only. The trust decision is re-made independently by each
 * operator's signer (validateGramReturn) before any funds move.
 */
export async function classifyPegOutDestination(
  destination: string,
  accountExists: (name: string) => Promise<boolean>,
): Promise<ReturnReason> {
  return (await accountExists(destination)) ? "" : "RETURN_INVALID_DEST";
}
