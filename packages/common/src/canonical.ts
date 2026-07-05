import { createHash } from "node:crypto";
import type { CanonicalAction, RemoteBurn, RemoteChainId, VizDeposit } from "./types";

/**
 * Deterministic canonical encoding + digest.
 *
 * Trust-critical: the digest MUST be a pure function of the source event so
 * that every honest operator, observing the same irreversible source event,
 * independently produces the same bytes and therefore the same digest. The
 * coordinator cannot make operators sign anything else, because each operator
 * recomputes this locally and refuses mismatches.
 */

function canonicalString(fields: Array<[string, string]>): string {
  // Length-prefixed, injective encoding. Each key and value is tagged with its
  // UTF-8 byte length ("<len>:<bytes>"), so no value can forge a field boundary
  // or shift the split between adjacent fields — distinct field arrays always
  // produce distinct strings. Keys are fixed literals; values are source-derived
  // and adversary-influenced (addresses, memos), so both are length-tagged.
  return fields
    .map(([k, v]) => `${Buffer.byteLength(k, "utf8")}:${k}=${Buffer.byteLength(v, "utf8")}:${v}`)
    .join("|");
}

function digestOf(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const REMOTE_CHAIN_BY_PREFIX: Record<string, RemoteChainId> = {
  ton: "TON",
  solana: "SOLANA",
};

/**
 * Parse a peg-in memo "<chain>:<address>" into its target chain + destination.
 * Trust-critical: every operator parses the same memo into the same target, so
 * the derived canonical action (and digest) match across operators.
 *
 * Throws on a missing/unknown chain prefix or an empty destination â a custody
 * bridge never silently defaults the target chain. The split is on the FIRST ':'
 * only; TON (EQ.../UQ... base64url) and Solana (base58) addresses never contain ':'.
 */
export function parseRemoteTarget(memo: string): { chain: RemoteChainId; destination: string } {
  const trimmed = memo.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0) {
    throw new Error(`peg-in memo missing chain prefix (expected "<chain>:<address>"): "${memo}"`);
  }
  const prefix = trimmed.slice(0, sep).toLowerCase();
  const destination = trimmed.slice(sep + 1).trim();
  const chain = REMOTE_CHAIN_BY_PREFIX[prefix];
  if (!chain) throw new Error(`peg-in memo has unknown chain prefix "${prefix}": "${memo}"`);
  if (!destination) throw new Error(`peg-in memo has empty destination: "${memo}"`);
  return { chain, destination };
}

/** VIZ deposit -> remote mint of wVIZ (chain committed in the digest). */
export function canonicalPegIn(d: VizDeposit): CanonicalAction {
  const id = `${d.trxId}:${d.opIndex}`;
  const body = canonicalString([
    ["v", "1"],
    ["dir", "PEG_IN"],
    ["src", id],
    ["chain", d.remoteChain],
    ["recipient", d.remoteDestination],
    ["amount_milli_viz", d.amountMilliViz.toString()],
  ]);
  return {
    direction: "PEG_IN",
    id,
    remoteChain: d.remoteChain,
    recipient: d.remoteDestination,
    amountMilliViz: d.amountMilliViz,
    digest: digestOf(body),
  };
}

/** Remote-chain burn/return -> VIZ release. */
export function canonicalPegOut(b: RemoteBurn): CanonicalAction {
  const id = b.sourceId;
  const body = canonicalString([
    ["v", "1"],
    ["dir", "PEG_OUT"],
    ["src", id],
    ["recipient", b.homeDestination],
    ["amount_milli_viz", b.amountMilliViz.toString()],
  ]);
  return {
    direction: "PEG_OUT",
    id,
    recipient: b.homeDestination,
    amountMilliViz: b.amountMilliViz,
    digest: digestOf(body),
  };
}
