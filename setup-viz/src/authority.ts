import type { Authority } from "viz-js-lib";

/**
 * Build a VIZ authority from accounts and/or keys, each weight 1, with the given
 * threshold. Graphene requires account_auths and key_auths to be sorted (by name
 * / by public key) or the node rejects the authority as non-canonical, so we
 * sort here.
 */
export function multisigAuthority(
  accounts: string[],
  threshold: number,
  keys: string[] = [],
): Authority {
  if (threshold < 1) throw new Error("threshold must be >= 1");
  const totalWeight = accounts.length + keys.length;
  if (threshold > totalWeight) {
    throw new Error(`threshold ${threshold} exceeds total signer weight ${totalWeight}`);
  }
  return {
    weight_threshold: threshold,
    account_auths: [...accounts].sort().map((a) => [a, 1] as [string, number]),
    key_auths: [...keys].sort().map((k) => [k, 1] as [string, number]),
  };
}
