import { createHash } from "node:crypto";
import type { OperatorRef } from "./types";

/** A VIZ authority: weighted accounts + keys with a weight threshold. */
export interface VizAuthority {
  weight_threshold: number;
  account_auths: Array<[string, number]>;
  key_auths: Array<[string, number]>;
}

/**
 * Parse the CLI operator spec "op-1=<vizPub>:<tonPub>[:<solPub>],op-2=...". Order is
 * preserved for display; authorities sort independently.
 *
 * solanaPubkey is OPTIONAL (2 or 3 fields), defaulting to "" — consistent with
 * parseManifest. A VIZ/TON-only rotation must not be forced to supply a Solana key the
 * operator may not have; the Solana rotation path (validateHandoffProposal) separately
 * requires every operator's solanaPubkey to be present, so an empty value fails there.
 */
export function parseOperators(spec: string): OperatorRef[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 0) throw new Error(`operator entry missing '=': ${entry}`);
      const id = entry.slice(0, eq).trim();
      const rest = entry.slice(eq + 1).trim();
      const parts = rest.split(":").map((p) => p.trim());
      if (parts.length !== 2 && parts.length !== 3) {
        throw new Error(`operator entry needs vizPub:tonPub[:solanaPub] (2 or 3 fields): ${entry}`);
      }
      const [vizPubkey, tonPubkey, solanaPubkey = ""] = parts;
      if (!id || !vizPubkey || !tonPubkey) {
        throw new Error(`operator entry incomplete (id, vizPub, tonPub required): ${entry}`);
      }
      return { id, vizPubkey, tonPubkey, solanaPubkey };
    });
}

/**
 * Inverse of parseOperators. Omits the Solana field when absent so a 2-field spec
 * round-trips (op=viz:ton), and emits all three when a Solana key is present.
 */
export function serializeOperators(ops: OperatorRef[]): string {
  return ops
    .map((o) => `${o.id}=${o.vizPubkey}:${o.tonPubkey}${o.solanaPubkey ? `:${o.solanaPubkey}` : ""}`)
    .join(",");
}

/**
 * Build the VIZ `active` authority for an operator set: raw key_auths only
 * (no account_auths), each weight 1, sorted (Graphene rejects non-canonical
 * ordering). Keys-only is required for the anonymous-operator model — the
 * evaluator calls get_account on every account_auths member.
 */
export function buildActiveAuthority(ops: OperatorRef[], threshold: number): VizAuthority {
  if (threshold < 1) throw new Error("threshold must be >= 1");
  if (threshold > ops.length) {
    throw new Error(`threshold ${threshold} exceeds operator count ${ops.length}`);
  }
  const keys = ops.map((o) => o.vizPubkey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate vizPubkey in operator set");
  return {
    weight_threshold: threshold,
    account_auths: [],
    key_auths: [...keys].sort().map((k) => [k, 1] as [string, number]),
  };
}

/** Canonical, order-independent hash of an authority (for anti-rollback check). */
export function authorityHash(auth: VizAuthority): string {
  const canonical = JSON.stringify({
    weight_threshold: auth.weight_threshold,
    account_auths: [...auth.account_auths].sort((a, b) => a[0].localeCompare(b[0])),
    key_auths: [...auth.key_auths].sort((a, b) => a[0].localeCompare(b[0])),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build the deterministic account_update operation tuple that rewrites
 * active + regular to the new operator set. `master` is intentionally OMITTED:
 * VIZ requires the master authority only when the op carries a master field, so
 * an active-only update needs just the current active T-of-N (verified against
 * viz-cpp-node chain_operations.hpp / chain_evaluator.cpp).
 */
export function buildRotationOp(
  account: string,
  ops: OperatorRef[],
  threshold: number,
  memoKey: string,
  jsonMetadata: string,
): [string, Record<string, unknown>] {
  const auth = buildActiveAuthority(ops, threshold);
  return [
    "account_update",
    {
      account,
      active: auth,
      regular: auth,
      memo_key: memoKey,
      json_metadata: jsonMetadata,
    },
  ];
}

/** TaPoS the proposer fixes; all partials sign over these exact bytes. */
export interface TaPoS {
  refBlockNum: number;
  refBlockPrefix: number;
  expiration: string; // "YYYY-MM-DDThh:mm:ss" UTC, no suffix
}

export interface RotationVizTx {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: Array<[string, Record<string, unknown>]>;
  extensions: unknown[];
  signatures: string[];
}

export interface RotationProposal {
  version: 1;
  chainId: string;
  newOperators: OperatorRef[];
  newThreshold: number;
  currentActiveHash: string;
  vizTx: RotationVizTx;
}

export interface BuildProposalArgs {
  chainId: string;
  account: string;
  newOperators: OperatorRef[];
  newThreshold: number;
  memoKey: string;
  jsonMetadata: string;
  currentActiveHash: string;
  taPoS: TaPoS;
}

export function buildProposal(a: BuildProposalArgs): RotationProposal {
  const op = buildRotationOp(a.account, a.newOperators, a.newThreshold, a.memoKey, a.jsonMetadata);
  return {
    version: 1,
    chainId: a.chainId,
    newOperators: a.newOperators,
    newThreshold: a.newThreshold,
    currentActiveHash: a.currentActiveHash,
    vizTx: {
      ref_block_num: a.taPoS.refBlockNum,
      ref_block_prefix: a.taPoS.refBlockPrefix,
      expiration: a.taPoS.expiration,
      operations: [op],
      extensions: [],
      signatures: [],
    },
  };
}

/**
 * Trust-critical: re-derive the account_update op from newOperators/newThreshold
 * and assert it is byte-identical to the op in the file, so a co-signer never
 * signs an authority other than the one the proposal claims. Also checks chainId
 * and non-expiry. memo_key/json_metadata are non-authority fields taken as-is.
 *
 * The transaction MUST carry exactly one operation and no extensions: a co-signer
 * signs the WHOLE vizTx, so any additional operation (e.g. a `transfer`) would be
 * authorized under the collected T-of-N even though only operations[0] is
 * validated here. Rejecting length != 1 / non-empty extensions closes that
 * multi-op injection path (audit VG-01).
 */
export function validateProposal(
  p: RotationProposal,
  ctx: { chainId: string; nowMs: number; skipExpiry?: boolean },
): void {
  if (p.version !== 1) throw new Error(`unsupported proposal version ${p.version}`);
  if (p.chainId !== ctx.chainId) {
    throw new Error(`proposal chainId '${p.chainId}' != expected '${ctx.chainId}'`);
  }
  if (!Array.isArray(p.vizTx.operations) || p.vizTx.operations.length !== 1) {
    throw new Error(
      `proposal must contain exactly one operation (got ${p.vizTx.operations?.length ?? 0}) — ` +
        "a rotation tx carries only the account_update; extra operations would be co-signed too",
    );
  }
  if (!Array.isArray(p.vizTx.extensions) || p.vizTx.extensions.length !== 0) {
    throw new Error("proposal vizTx.extensions must be empty");
  }
  const fileOp = p.vizTx.operations[0];
  if (!fileOp || fileOp[0] !== "account_update") throw new Error("proposal op is not account_update");
  if (fileOp[1].master !== undefined) throw new Error("proposal op must not change master");
  const account = String(fileOp[1].account ?? "");
  const expected = buildRotationOp(
    account,
    p.newOperators,
    p.newThreshold,
    String(fileOp[1].memo_key ?? ""),
    String(fileOp[1].json_metadata ?? ""),
  );
  if (JSON.stringify(expected) !== JSON.stringify(fileOp)) {
    throw new Error("proposal op does not match newOperators/newThreshold (tampered or stale)");
  }
  // VIZ expiration is UTC without suffix; treat as UTC.
  const expMs = Date.parse(`${p.vizTx.expiration}Z`);
  if (Number.isNaN(expMs)) throw new Error(`bad expiration: ${p.vizTx.expiration}`);
  if (!ctx.skipExpiry && ctx.nowMs >= expMs) throw new Error("proposal expired (re-run propose for a fresh TaPoS window)");
}

/** Append a partial signature (deduped, order-independent). Returns a new proposal. */
export function addPartial(p: RotationProposal, signature: string): RotationProposal {
  if (p.vizTx.signatures.includes(signature)) return p;
  return { ...p, vizTx: { ...p.vizTx, signatures: [...p.vizTx.signatures, signature] } };
}

/** The cross-chain rotation checkpoint, written alongside the proposal. */
export interface RotationState {
  proposalFile: string;
  vizDone: boolean;
  tonOrderAddress: string;
  tonDone: boolean;
  solanaNewMultisig: string; // address authority was handed to (empty until broadcast-solana)
  solanaDone: boolean;
}

/** Pure merge: overlay `patch` onto `state`, preserving untouched fields. */
export function mergeState(state: RotationState, patch: Partial<RotationState>): RotationState {
  return { ...state, ...patch };
}
