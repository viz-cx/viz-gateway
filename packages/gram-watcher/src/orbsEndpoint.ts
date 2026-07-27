import { TonClient } from "@ton/ton";
import { getHttpEndpoint } from "@orbs-network/ton-access";

/**
 * Orbs ton-access is the only viable drop-in fallback for toncenter v2: it hands back a
 * decentralized, v2-jsonRPC-compatible endpoint URL (a static Orbs path 404s; the SDK's
 * getHttpEndpoint() is required). We resolve it ONCE at boot (it is async and would otherwise
 * be a per-request cost) and append the concrete URL to the GRAM endpoint failover list, so
 * GramHttpChain/GramApprover treat it as just another endpoint to rotate onto.
 */

export type OrbsNetwork = "mainnet" | "testnet";

export interface ResolveOrbsDeps {
  /** Injectable Orbs resolver (defaults to the SDK). Returns a v2-jsonRPC endpoint URL. */
  resolve?: (network: OrbsNetwork) => Promise<string>;
  /** Injectable liveness probe (defaults to a getMasterchainInfo call). MUST throw on a dead URL. */
  verify?: (url: string) => Promise<void>;
  network?: OrbsNetwork;
}

/**
 * Optionally append an Orbs ton-access fallback endpoint to the operator's configured TON
 * endpoint list.
 *
 * FAIL-SOFT by design: a resolution or verification failure logs and returns the configured
 * list UNCHANGED. The fallback must never be able to break the primary (toncenter) read path
 * or block process boot — a bad Orbs URL would only add latency + a guaranteed failure to the
 * failover ring, so we append it only after it answers a real read. With `enableOrbs=false`
 * (the default), this is a pure pass-through and makes NO network call — tests / local runs are
 * unaffected. The resolved URL takes no toncenter API key (buildTonClients keys toncenter hosts
 * only).
 */
export async function resolveGramEndpoints(
  configured: string[],
  enableOrbs: boolean,
  deps: ResolveOrbsDeps = {},
): Promise<string[]> {
  if (!enableOrbs) return configured;
  const resolve = deps.resolve ?? ((network) => getHttpEndpoint({ network }));
  const verify = deps.verify ?? defaultVerify;
  const network = deps.network ?? "mainnet";
  try {
    const url = (await resolve(network)).trim();
    if (!url) {
      console.warn("[gram] Orbs ton-access returned an empty endpoint; keeping configured endpoints only");
      return configured;
    }
    if (configured.includes(url)) return configured; // already in the list — nothing to add
    await verify(url);
    console.log(`[gram] Orbs ton-access fallback endpoint resolved + verified: ${url}`);
    return [...configured, url];
  } catch (err) {
    console.warn(`[gram] Orbs ton-access fallback unavailable (keeping configured endpoints only): ${String(err)}`);
    return configured;
  }
}

/** Trust an endpoint only once it answers a real masterchain read. */
async function defaultVerify(url: string): Promise<void> {
  const client = new TonClient({ endpoint: url, timeout: 10_000 });
  await client.getMasterchainInfo();
}
