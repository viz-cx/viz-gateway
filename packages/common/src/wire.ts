import type { CanonicalAction } from "./types";

// CanonicalAction.amountMilliViz is a bigint, which JSON.stringify cannot
// serialize. These helpers convert it to/from a string at HTTP boundaries
// (watcher -> coordinator -> signer). Proposals carry only strings already.

export function actionToWire(a: CanonicalAction): Record<string, unknown> {
  return { ...a, amountMilliViz: a.amountMilliViz.toString() };
}

export function actionFromWire(o: Record<string, unknown>): CanonicalAction {
  return {
    direction: o["direction"] as CanonicalAction["direction"],
    id: String(o["id"]),
    recipient: String(o["recipient"]),
    amountMilliViz: BigInt(String(o["amountMilliViz"])),
    digest: String(o["digest"]),
  };
}
