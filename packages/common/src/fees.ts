// Peg-in fee, in integer milli-VIZ (1 VIZ = 1000 milli-VIZ).
//
// Decision: the fee is taken on the VIZ side and HELD IN VIZ. The user locks
// `gross` VIZ; we mint only `net` wVIZ to the recipient; the fee stays as VIZ
// surplus on the gateway account and is swept to `fees.gate`. Peg-out is free.
//
// Two components:
//   base       = max(floor, bps%)            — pure function of `gross` (immutable
//                                              source amount), so every operator
//                                              derives the SAME base independently.
//   activation = 0 or activationSurcharge    — charged when the destination address
//                                              is not provisioned yet (Solana ATA /
//                                              TON jetton-wallet rent the gateway
//                                              would otherwise eat). This depends on
//                                              a remote-chain read, so it is read
//                                              ONCE by the proposer and pinned; the
//                                              signer re-derives `base` but accepts
//                                              the pinned `destProvisioned` flag (a
//                                              wrong flag only shifts <= the surcharge
//                                              between the user and gateway, never the
//                                              backing — see keyedSigner.assertNet).
//
// `net = gross − base − activation`. A deposit that cannot cover the fee plus a
// minimum mint-gas floor is rejected (P1: no fixed MIN_PEGIN; refund instead).
//
// FEE SWEEP (VG-04): only `base` is ever swept to fees.gate. The exact fee would need
// the mint-time `destProvisioned` bit, but the sweep is spawned AFTER the mint has
// provisioned the destination, so no independent read can recover that bit at sweep
// time. `base` is chain-independent (floor + bps) and both the dispatcher (spawn) and
// the signer (validateFeeSweep) derive it from the immutable gross, leaving the
// coordinator no discretion. Any `activation` withheld is deliberately RETAINED on the
// gateway as backing surplus (fail-safe: over-backed, never under; recon counts it as
// unswept fees). `PegInBreakdown.fee` (= base + activation) is the total WITHHELD from
// net; `base` alone is the SWEPT amount.

export interface PegInFeePolicy {
  /** Flat floor (default 10 VIZ). */
  floorMilliViz: bigint;
  /** Basis points (20 = 0.20%); 0 disables the percentage component. */
  bps: number;
  /** Surcharge when the destination address is not provisioned (per-chain). */
  activationSurchargeMilliViz: bigint;
  /** Net must cover at least this (mint-gas floor), else reject for refund. */
  mintGasFloorMilliViz: bigint;
}

export interface PegInBreakdown {
  gross: bigint;
  base: bigint;
  activation: bigint;
  fee: bigint; // base + activation
  net: bigint; // gross − fee
}

export type PegInQuote =
  | { ok: true; b: PegInBreakdown }
  | { ok: false; reason: "BELOW_MIN"; minMilliViz: bigint };

/** Deterministic base fee from the (immutable) gross deposit amount. */
export function baseFee(grossMilliViz: bigint, p: PegInFeePolicy): bigint {
  const pct = (grossMilliViz * BigInt(p.bps)) / 10000n;
  return pct > p.floorMilliViz ? pct : p.floorMilliViz;
}

/**
 * Full peg-in quote. `destProvisioned` is the pinned remote-chain fact (false ->
 * charge the activation surcharge). Rejects (for refund) when net would be <= 0 or
 * below the mint-gas floor.
 */
export function quotePegIn(grossMilliViz: bigint, destProvisioned: boolean, p: PegInFeePolicy): PegInQuote {
  const base = baseFee(grossMilliViz, p);
  const activation = destProvisioned ? 0n : p.activationSurchargeMilliViz;
  const fee = base + activation;
  const net = grossMilliViz - fee;
  if (net <= 0n || net < p.mintGasFloorMilliViz) {
    return { ok: false, reason: "BELOW_MIN", minMilliViz: fee + p.mintGasFloorMilliViz };
  }
  return { ok: true, b: { gross: grossMilliViz, base, activation, fee, net } };
}

/**
 * ceil(gasTon * vizPerTon * margin) VIZ in integer milli-VIZ. Rounds UP so a
 * rounding unit can never make the fee under-cover the gas it must pay. Used once
 * at config load to turn the static VIZ/TON rate into the GRAM floor + activation.
 */
export function deriveFloorMilliViz(gasTon: number, vizPerTon: number, margin: number): bigint {
  return BigInt(Math.ceil(gasTon * vizPerTon * margin * 1000));
}
