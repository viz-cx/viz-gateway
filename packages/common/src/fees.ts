// Peg-in fee + minimum, in integer milli-VIZ (1 VIZ = 1000 milli-VIZ).
//
// The VIZ side is always free. This fee exists only to cover the TON mint gas
// plus a small sustainability margin. It is collected in wVIZ at mint time
// (net to the user, fee to the treasury), so the 1:1 backing is preserved:
// locked VIZ == minted wVIZ (user net + treasury fee). Peg-out is free.

export interface FeePolicy {
  /** Flat fee floor; covers one TON mint with margin. */
  flatFloorMilliViz: bigint;
  /** Basis points (30 = 0.30%); set 0 to disable the percentage component. */
  bps: number;
  /** Reject dust peg-ins that the fixed gas would dominate. */
  minPegInMilliViz: bigint;
}

export type PegInQuote =
  | { ok: true; gross: bigint; fee: bigint; net: bigint }
  | { ok: false; reason: "BELOW_MIN"; minMilliViz: bigint };

/** Quote a peg-in: fee = max(flat floor, bps% of amount); reject below the minimum. */
export function quotePegIn(grossMilliViz: bigint, p: FeePolicy): PegInQuote {
  if (grossMilliViz < p.minPegInMilliViz) {
    return { ok: false, reason: "BELOW_MIN", minMilliViz: p.minPegInMilliViz };
  }
  const pct = (grossMilliViz * BigInt(p.bps)) / 10000n;
  const fee = pct > p.flatFloorMilliViz ? pct : p.flatFloorMilliViz;
  return { ok: true, gross: grossMilliViz, fee, net: grossMilliViz - fee };
}
