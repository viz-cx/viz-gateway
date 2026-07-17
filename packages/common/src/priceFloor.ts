// Dynamic GRAM peg-in fee floor derived from manual per-signer VIZ/TON price quotes.
// The gas cost is a TON-denominated constant; only the VIZ/TON rate (vizPerTon =
// VIZ per 1 TON) varies, and it is sourced from signer quotes (see coordinator
// registry). floorMilliViz = ceil(gasTon * vizPerTon * margin * 1000). Rounding is
// ALWAYS up so a rounding unit can never make the fee under-cover the gas it must pay.
import type { GatewayFeeConfig } from "./config";
import type { PegInFeePolicy } from "./fees";

/** Median of a non-empty list. Even length -> mean of the two middle values. */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  // Non-null: xs.length > 0 checked above, so these indices are always in-range.
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Clamp a vizPerTon quote into the manifest band before it can move the fee. */
export function clampVizPerTon(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** ceil(gasTon * vizPerTon * margin) VIZ, expressed in integer milli-VIZ. */
export function deriveFloorMilliViz(gasTon: number, vizPerTon: number, margin: number): bigint {
  const milliViz = gasTon * vizPerTon * margin * 1000;
  return BigInt(Math.ceil(milliViz));
}

/**
 * Build the GRAM PegInFeePolicy for a given (unclamped) vizPerTon: the flat floor
 * covers the recurring mint gas; the activation surcharge covers the one-time wallet
 * deploy. Both are derived from the SAME clamped vizPerTon so they scale together.
 */
export function deriveGramFeePolicy(fees: GatewayFeeConfig, vizPerTon: number): PegInFeePolicy {
  const v = clampVizPerTon(vizPerTon, fees.minVizPerTon, fees.maxVizPerTon);
  return {
    floorMilliViz: deriveFloorMilliViz(fees.mintGasTon, v, fees.margin),
    bps: fees.bps,
    activationSurchargeMilliViz: deriveFloorMilliViz(fees.walletDeployGasTon, v, fees.margin),
    mintGasFloorMilliViz: fees.mintGasFloorMilliViz.GRAM,
  };
}

/**
 * The base-fee band implied by the vizPerTon clamp. A signer accepts the
 * coordinator's net iff the implied base fee is within [feeLo, feeHi] (+activation),
 * bounding coordinator discretion to the band (bounded-trust; see keyedSigner).
 */
export function clampBand(fees: GatewayFeeConfig): { feeLo: bigint; feeHi: bigint } {
  return {
    feeLo: deriveFloorMilliViz(fees.mintGasTon, fees.minVizPerTon, fees.margin),
    feeHi: deriveFloorMilliViz(fees.mintGasTon, fees.maxVizPerTon, fees.margin),
  };
}
