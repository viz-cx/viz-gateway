import type { GatewayFeeConfig } from "@gateway/common";

/**
 * Strict allowlist echo (no wildcard): a listed Origin is reflected back so the
 * browser permits the cross-origin read; anything else gets no ACAO header and
 * is blocked. Same-origin requests carry no Origin and need no header.
 */
export function corsHeadersFor(origin: string | undefined, allowed: string[]): Record<string, string> {
  if (origin && allowed.includes(origin)) {
    return { "access-control-allow-origin": origin, "vary": "Origin" };
  }
  return {};
}

/**
 * Public /fees payload. Whitelisted fields ONLY — never spread the whole config,
 * so growth in GatewayFeeConfig can't leak internal knobs. milliViz values fit
 * safely in a JS number. `decimals` is VIZ's fixed milli precision.
 */
export function serializeFees(fees: GatewayFeeConfig): Record<string, unknown> {
  return {
    floorMilliViz: Number(fees.floorMilliViz),
    bps: fees.bps,
    activationSurchargeMilliViz: {
      GRAM: Number(fees.activationSurchargeMilliViz.GRAM),
      SOLANA: Number(fees.activationSurchargeMilliViz.SOLANA),
    },
    mintGasFloorMilliViz: {
      GRAM: Number(fees.mintGasFloorMilliViz.GRAM),
      SOLANA: Number(fees.mintGasFloorMilliViz.SOLANA),
    },
    refundFeeMilliViz: Number(fees.refundFeeMilliViz),
    decimals: 3,
  };
}
