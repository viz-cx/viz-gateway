import { createHash } from "node:crypto";
import type { CanonicalAction, RemoteBurn, VizDeposit } from "./types";

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
  // Fixed field order, explicit separators, no JSON ambiguity.
  return fields.map(([k, v]) => `${k}=${v}`).join("");
}

function digestOf(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** VIZ deposit -> TON mint of wVIZ. */
export function canonicalPegIn(d: VizDeposit): CanonicalAction {
  const id = `${d.trxId}:${d.opIndex}`;
  const body = canonicalString([
    ["v", "1"],
    ["dir", "PEG_IN"],
    ["src", id],
    ["recipient", d.tonDestination],
    ["amount_milli_viz", d.amountMilliViz.toString()],
  ]);
  return {
    direction: "PEG_IN",
    id,
    recipient: d.tonDestination,
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
