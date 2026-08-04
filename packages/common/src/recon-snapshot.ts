/**
 * Durable recon snapshot: the figures `Recon.check()` computes every tick, published
 * through the `gateway_state` KV so the coordinator can serve them on GET /recon.
 *
 * Pure codec, no I/O — one source of truth for the writer (recon) and the reader
 * (coordinator), so the wire shape can't drift between them.
 *
 * INVARIANT ON THE WRITE SIDE: only a DEFINITIVE check writes a snapshot. An
 * indeterminate tick (a failed backing/supply read) must leave the previous snapshot
 * in place rather than publish a substituted number — the same rule that PR #111 and
 * PR #122 established for the pause decision. Consumers judge freshness by
 * `checkedAt`, never by the mere presence of a snapshot.
 */

/** KV key for one chain's snapshot. Namespaced away from cursors and the pause flag. */
export function reconSnapshotKey(chain: string): string {
  return `recon:snapshot:${chain}`;
}

export type ReconStatus = "OK" | "UNDER_BACKED";

export interface ReconSnapshot {
  chain: string;
  /** VIZ held in this chain's gateway account. */
  lockedMilliViz: bigint;
  /** wVIZ in circulation on the remote (total supply − gateway-held). */
  circulatingMilliViz: bigint;
  /** Peg-in fees minted-but-not-yet-swept: backing that is owed, not surplus. */
  unsweptFeesMilliViz: bigint;
  /** locked − (circulating + unsweptFees). Positive = over-backed = the safe side. */
  driftMilliViz: bigint;
  status: ReconStatus;
  /** ms epoch of the check that produced these figures. */
  checkedAt: number;
}

/** JSON for the KV. bigints go out as decimal strings — JSON has no bigint. */
export function serializeReconSnapshot(s: ReconSnapshot): string {
  return JSON.stringify({
    chain: s.chain,
    lockedMilliViz: String(s.lockedMilliViz),
    circulatingMilliViz: String(s.circulatingMilliViz),
    unsweptFeesMilliViz: String(s.unsweptFeesMilliViz),
    driftMilliViz: String(s.driftMilliViz),
    status: s.status,
    checkedAt: s.checkedAt,
  });
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Parse a KV value back into a snapshot. NEVER throws: absent, malformed, or
 * partially-written JSON yields null, and the caller reports "no data" instead of
 * fabricating figures. Unknown fields are ignored so a future writer can add some.
 */
export function parseReconSnapshot(json: string | null | undefined): ReconSnapshot | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const locked = toBigInt(o["lockedMilliViz"]);
  const circulating = toBigInt(o["circulatingMilliViz"]);
  const unswept = toBigInt(o["unsweptFeesMilliViz"]);
  const drift = toBigInt(o["driftMilliViz"]);
  const status = o["status"];
  const checkedAt = o["checkedAt"];
  const chain = o["chain"];

  if (locked === null || circulating === null || unswept === null || drift === null) return null;
  if (status !== "OK" && status !== "UNDER_BACKED") return null;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  if (typeof chain !== "string" || chain.length === 0) return null;

  return {
    chain,
    lockedMilliViz: locked,
    circulatingMilliViz: circulating,
    unsweptFeesMilliViz: unswept,
    driftMilliViz: drift,
    status,
    checkedAt,
  };
}
