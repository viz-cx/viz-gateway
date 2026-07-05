import type {
  Approval,
  CanonicalAction,
  Signer,
  SolanaMintProposal,
  TonMintProposal,
  VizReleaseProposal,
} from "@gateway/common";

type AnyProposal = VizReleaseProposal | TonMintProposal | SolanaMintProposal;

/** A Solana mint proposal carries the compiled message + mint + multisig. */
export function isSolanaMintProposal(p: unknown): p is SolanaMintProposal {
  return (
    typeof p === "object" &&
    p !== null &&
    "messageB64" in p &&
    "mint" in p &&
    "multisig" in p
  );
}

/** A TON mint proposal carries the order hash operators sign. */
export function isTonMintProposal(p: unknown): p is TonMintProposal {
  return typeof p === "object" && p !== null && "orderHashHex" in p;
}

/**
 * Route an approval request to the right signing method. PEG_OUT releases on VIZ;
 * PEG_IN is discriminated by proposal SHAPE (the signer's independent backstop),
 * cross-checked against the action's committed `remoteChain` when present. The
 * per-method validators still re-check recipient/amount before signing.
 */
export async function routeApproval(
  signer: Signer,
  action: CanonicalAction,
  proposal: AnyProposal,
): Promise<Approval> {
  if (action.direction === "PEG_OUT") {
    return signer.signVizRelease(action, proposal as VizReleaseProposal);
  }
  if (isSolanaMintProposal(proposal)) {
    if (action.remoteChain && action.remoteChain !== "SOLANA") {
      throw new Error(`Solana proposal for a ${action.remoteChain} action (${action.id})`);
    }
    return signer.approveSolanaMint(action, proposal);
  }
  if (isTonMintProposal(proposal)) {
    if (action.remoteChain && action.remoteChain !== "GRAM") {
      throw new Error(`GRAM proposal for a ${action.remoteChain} action (${action.id})`);
    }
    return signer.approveTonMint(action, proposal);
  }
  throw new Error(`PEG_IN proposal shape not recognized (neither GRAM nor Solana) for ${action.id}`);
}
