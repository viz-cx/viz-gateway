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

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GRAM_ADDR_RE = /^[EU]Q[A-Za-z0-9_-]{46}$/;

/**
 * Validate a remote chain destination address shape. Throws on empty, on
 * addresses containing ':' (no memo prefix allowed -- routing is by receiving
 * account now), or on an address that doesn't match the chain's expected format.
 * Trust-critical: every operator validates the same address against the same
 * rules, so a malformed destination is uniformly rejected before signing.
 */
export function validateRemoteAddress(chain: RemoteChainId, address: string): void {
  if (!address) throw new Error(`peg-in destination is empty for chain ${chain}`);
  if (address.includes(":")) throw new Error(`peg-in destination must not contain ':' (${address})`);
  const re = chain === "SOLANA" ? SOLANA_ADDR_RE : GRAM_ADDR_RE;
  if (!re.test(address)) throw new Error(`invalid ${chain} destination address: ${address}`);
}

/**
 * VIZ deposit -> remote mint of wVIZ (chain committed in the digest).
 *
 * The digest commits the GROSS deposit amount — it is a SOURCE binding, not an economic
 * one (VG M4). The minted NET (= gross − base − activation) is deliberately NOT in the
 * digest: each signer RE-DERIVES it from the gross using its own fee config and rejects a
 * mismatch (keyedSigner.assertNet). So if operators' fee configs diverge they compute
 * different NETs, the odd one out refuses, and the mint simply never reaches threshold — a
 * LIVENESS stall, never a wrong-amount mint. Operators MUST therefore share one fee config
 * (the committed federation manifest, not per-host env) or peg-ins wedge. Putting NET in the
 * digest would only turn that liveness stall into a digest mismatch — same outcome — so the
 * source-binding digest + independent assertNet is the intended, theft-safe design.
 */
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
    ["chain", b.chain],
    ["src", id],
    ["recipient", b.homeDestination],
    ["amount_milli_viz", b.amountMilliViz.toString()],
  ]);
  return {
    direction: "PEG_OUT",
    id,
    recipient: b.homeDestination,
    amountMilliViz: b.amountMilliViz,
    remoteChain: b.chain,
    digest: digestOf(body),
  };
}
