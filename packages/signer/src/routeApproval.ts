import type {
  Approval,
  CanonicalAction,
  Signer,
  SolanaMintProposal,
  GramMintProposal,
  VizReleaseProposal,
} from "@gateway/common";

type AnyProposal = VizReleaseProposal | GramMintProposal | SolanaMintProposal;

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
export function isGramMintProposal(p: unknown): p is GramMintProposal {
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
  if (action.direction === "GRAM_RETURN") {
    if (!isGramMintProposal(proposal)) {
      throw new Error(`GRAM_RETURN proposal shape not recognized for ${action.id}`);
    }
    return signer.approveGramReturn(action, proposal as GramMintProposal);
  }
  if (action.direction === "PEG_OUT") {
    return signer.signVizRelease(action, proposal as VizReleaseProposal);
  }
  if (isSolanaMintProposal(proposal)) {
    if (action.remoteChain && action.remoteChain !== "SOLANA") {
      throw new Error(`Solana proposal for a ${action.remoteChain} action (${action.id})`);
    }
    return signer.approveSolanaMint(action, proposal);
  }
  if (isGramMintProposal(proposal)) {
    if (action.remoteChain && action.remoteChain !== "GRAM") {
      throw new Error(`GRAM proposal for a ${action.remoteChain} action (${action.id})`);
    }
    return signer.approveGramMint(action, proposal);
  }
  throw new Error(`PEG_IN proposal shape not recognized (neither GRAM nor Solana) for ${action.id}`);
}
