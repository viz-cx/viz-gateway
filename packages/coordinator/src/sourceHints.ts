import { readFileSync } from "node:fs";
import type { CanonicalAction, GatewayStore, SourceHint } from "@gateway/common";
import { notifyStaff } from "@gateway/log";

/**
 * Operator resolution-directive file (`config/source-hints.json`) — the "edit a file, pull,
 * restart" path for stuck peg-ins whose F2 re-read fails because the deposit's VIZ block was
 * pruned from operation_history (see docs/plan-refund-pruned-history-getblock.md). It does two
 * things, both trustless:
 *   (a) supplies `sourceBlockNum` as the UNTRUSTED out-of-band getDeposit block-log hint when the
 *       DB row's block_num is NULL (pre-column rows) — each signer still re-reads the block from
 *       its OWN node and recomputes the trx id, so a wrong number just fails closed; and
 *   (b) `resolution:"mint"` performs a run-once state redirect: abandon the stuck REFUND child and
 *       re-drive the parent PEG_IN mint, so a valid peg-in that only failed during an outage window
 *       completes (full wVIZ) instead of refunding. The directive selects mint-vs-refund ONLY; the
 *       recipient is memo-derived and re-validated by every signer — operators cannot redirect funds.
 *
 * Consumption model: ONLY the coordinator reads this file. Ops edit it + pull/restart the
 * coordinator. Signers never read it — they only receive the (untrusted) block number.
 */

export type SourceResolution = "mint" | "refund";

export interface SourceHintDirective {
  /** UNTRUSTED parent PEG_IN source block number; the getDeposit block-log hint (DB NULL fallback). */
  sourceBlockNum?: number;
  /** "mint" = redirect the stuck refund to complete the peg-in; omitted/"refund" = today's default. */
  resolution?: SourceResolution;
}

export type SourceHintsFile = Record<string, SourceHintDirective>;

/** Child-id suffixes whose parent is a VIZ PEG_IN (so a VIZ source block backs their F2 re-read). */
const REFUND_SUFFIX = ":refund";
const FEE_SWEEP_SUFFIX = ":fee";

/** gateway_state marker key so a mint redirect applies exactly once (idempotent across restarts). */
const APPLIED_PREFIX = "source-hint-applied:";

/**
 * Load + schema-validate the directive file. Fail-closed: a missing file is the normal case
 * (no directives); a malformed file or entry is DROPPED with a warning rather than trusted, so a
 * bad edit can never inject a bogus block number or resolution. Only whole-object shape is
 * enforced here; the block number stays untrusted regardless (verified own-node at read time).
 */
export function loadSourceHints(filePath: string): SourceHintsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[coordinator] could not load source-hints ${filePath}: ${String(err)} — no directives`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[coordinator] source-hints ${filePath} is not a JSON object — no directives`);
    return {};
  }
  const out: SourceHintsFile = {};
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      console.warn(`[coordinator] source-hints entry ${id} is not an object — skipped`);
      continue;
    }
    const d = raw as Record<string, unknown>;
    const dir: SourceHintDirective = {};
    if (d["sourceBlockNum"] !== undefined) {
      const n = d["sourceBlockNum"];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        console.warn(`[coordinator] source-hints entry ${id} has invalid sourceBlockNum ${String(n)} — skipped`);
        continue;
      }
      dir.sourceBlockNum = n;
    }
    if (d["resolution"] !== undefined) {
      if (d["resolution"] !== "mint" && d["resolution"] !== "refund") {
        console.warn(`[coordinator] source-hints entry ${id} has invalid resolution ${String(d["resolution"])} — skipped`);
        continue;
      }
      dir.resolution = d["resolution"];
    }
    // Canonicalize the key to lowercase: an action id is "<trxIdHex>:<opIndex>" and the chain
    // returns the trx id lowercase (so the store id + computeTrxId are lowercase), while operators
    // often paste the UPPERCASE explorer value. Lowercasing a "<hex>:<int>" id is loss-free and
    // makes the file case-insensitive, so a pasted explorer id still matches the store row.
    out[id.toLowerCase()] = dir;
  }
  return out;
}

/** The parent PEG_IN action id whose VIZ block backs `action`'s F2 re-read, or null (no VIZ parent). */
export function parentPegInIdOf(action: CanonicalAction): string | null {
  if (action.direction === "PEG_IN") return action.id;
  if (action.id.endsWith(REFUND_SUFFIX)) return action.id.slice(0, -REFUND_SUFFIX.length);
  if (action.id.endsWith(FEE_SWEEP_SUFFIX)) return action.id.slice(0, -FEE_SWEEP_SUFFIX.length);
  return null; // PEG_OUT / GRAM_RETURN: no VIZ source block
}

/**
 * Resolve the UNTRUSTED block-log hint for an action: the parent PEG_IN's persisted block_num,
 * or the directive file's sourceBlockNum when the DB value is NULL (rows predating the column).
 * DB WINS over the file (the on-chain-derived value is authoritative when present). The signer
 * re-reads the block from its own node + recomputes the trx id, so a wrong number fails closed.
 */
export async function resolveSourceHint(
  action: CanonicalAction,
  store: Pick<GatewayStore, "get">,
  hints: SourceHintsFile,
): Promise<SourceHint | undefined> {
  const parentId = parentPegInIdOf(action);
  if (!parentId) return undefined;
  const rec = await store.get(parentId);
  if (rec?.blockNum != null) return { sourceBlockNum: rec.blockNum };
  const fileBlock = hints[parentId]?.sourceBlockNum;
  if (fileBlock != null) return { sourceBlockNum: fileBlock };
  return undefined;
}

type RedirectStore = Pick<GatewayStore, "get" | "setStatus" | "getState" | "setState" | "isPaused">;

/**
 * Apply `resolution:"mint"` directives once each at coordinator boot: abandon the stuck REFUND
 * child (so we can never both mint AND later broadcast the refund) and re-drive the parent PEG_IN
 * mint. Idempotent — a gateway_state marker makes a restart a no-op.
 *
 * SAFETY — runs ONLY while the gateway is paused. The redirect mutates outbox state; while paused
 * the dispatcher skips ticks and signers refuse, so nothing is delivering/signing and there is no
 * race that could let BOTH the refund and the mint go out. The operator therefore pauses before
 * deploying (see docs/runbook-mainnet-bringup.md); we refuse (defer) otherwise. Belt-and-suspenders
 * on top of pause: never mint if the refund child already CONFIRMED or has a pinned txid (a release
 * may be on-chain) — a stuck refund never reached threshold, so its txid is null.
 */
export async function applySourceHintResolutions(store: RedirectStore, hints: SourceHintsFile): Promise<void> {
  const mintDirectives = Object.entries(hints).filter(([, d]) => d.resolution === "mint");
  if (mintDirectives.length === 0) return;
  if (!(await store.isPaused())) {
    console.warn(
      `[coordinator] ${mintDirectives.length} source-hint mint directive(s) pending, but the gateway is NOT paused — ` +
        `deferring redirect. Pause the gateway and restart the coordinator to apply (see RUNBOOK).`,
    );
    return;
  }
  for (const [parentId, dir] of mintDirectives) {
    void dir; // resolution already filtered to "mint"
    const marker = `${APPLIED_PREFIX}${parentId}`;
    if (await store.getState(marker)) continue; // run-once

    const parent = await store.get(parentId);
    if (!parent) {
      console.warn(`[coordinator] source-hint mint ${parentId}: no such outbox row — skipped (check the id; not marking done)`);
      continue; // the row may be enqueued later; retry next boot
    }
    if (parent.direction !== "PEG_IN") {
      console.warn(`[coordinator] source-hint mint ${parentId}: row is ${parent.direction}, not PEG_IN — skipped`);
      await store.setState(marker, String(Date.now()));
      continue;
    }
    if (parent.status === "CONFIRMED") {
      await store.setState(marker, String(Date.now())); // already minted — nothing to do
      continue;
    }
    if (!["REFUNDING", "REFUNDED", "HELD"].includes(parent.status)) {
      // In-flight (SEEN/QUEUED/SIGNING/BROADCAST): the mint may still complete on its own. Don't
      // disturb it; retry on the next boot (marker deliberately not set).
      console.log(`[coordinator] source-hint mint ${parentId}: parent is ${parent.status} (in-flight) — deferring`);
      continue;
    }

    // Double-pay guard: if the refund child already delivered (or a release is in-flight), NEVER
    // also mint. A stuck refund never reached threshold, so txid is null; a non-null txid or a
    // CONFIRMED child means a real VIZ release may be on-chain.
    const child = await store.get(`${parentId}${REFUND_SUFFIX}`);
    if (child && (child.status === "CONFIRMED" || child.txid != null)) {
      console.warn(
        `[coordinator] source-hint mint ${parentId}: refund child already ${child.status}` +
          `${child.txid ? ` (txid ${child.txid})` : ""} — refusing to also mint (no double-pay). No-op.`,
      );
      notifyStaff("refund", `source-hint mint redirect for ${parentId} SKIPPED: refund already delivered/in-flight`, { id: parentId });
      await store.setState(marker, String(Date.now()));
      continue;
    }

    // Abandon the stuck refund child FIRST (so it can never broadcast), then re-drive the parent.
    // A crash between the two re-runs this branch next boot (marker unset) — both writes are
    // idempotent (child already FAILED still passes the guard; parent already QUEUED is harmless).
    if (child) {
      await store.setStatus(child.id, "FAILED", { lastError: `abandoned by source-hint mint redirect for ${parentId}` });
    }
    await store.setStatus(parentId, "QUEUED", {
      lastError: "re-driven to mint by source-hint directive",
      nextAttemptAt: Date.now(),
    });
    await store.setState(marker, String(Date.now()));
    console.log(`[coordinator] source-hint mint ${parentId}: abandoned refund child + re-drove parent PEG_IN -> QUEUED`);
    notifyStaff("deposits", `source-hint mint redirect applied for ${parentId}: refund abandoned, PEG_IN re-driven to mint`, { id: parentId });
  }
}
