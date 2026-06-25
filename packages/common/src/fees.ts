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
//                                              the pinned `destProvisioned` flag.
//
// `net = gross − base − activation`. A deposit that cannot cover the fee plus a
// minimum mint-gas floor is rejected (P1: no fixed MIN_PEGIN; refund instead).

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
