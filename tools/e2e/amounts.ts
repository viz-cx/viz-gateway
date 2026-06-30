import { quotePegIn, pegInFeePolicyFor, type GatewayFeeConfig } from "@gateway/common";
import type { RemoteChainId } from "@gateway/common";

/** Deterministic 0–999 mVIZ jitter from the runId so each run is locatable. */
function jitter(runId: string): bigint {
  let h = 0;
  for (const ch of runId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BigInt(h % 1000);
}

export function uniqueGrossMilliViz(baseMilliViz: bigint, runId: string): bigint {
  return baseMilliViz + jitter(runId);
}

export function expectedNetMilliViz(
  gross: bigint,
  fees: GatewayFeeConfig,
  chain: RemoteChainId,
  destProvisioned: boolean,
): bigint {
  const quote = quotePegIn(gross, destProvisioned, pegInFeePolicyFor(fees, chain));
  if (!quote.ok) throw new Error(`e2e gross ${gross} below min ${quote.minMilliViz}`);
  return quote.b.net;
}

export { assertDelta } from "./deltas";
