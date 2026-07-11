import viz, {
  type Account,
  type AnnotatedTransaction,
  type BroadcastResult,
  type DynamicGlobalProperties,
  type OpWrapper,
} from "viz-js-lib";
import {
  validateRemoteAddress,
  GatewayAccounts,
  type CanonicalAction,
  type VizChain,
  type VizDeposit,
  type VizReleaseProposal,
} from "@gateway/common";
import { buildReleaseTx, releaseTxId } from "./vizSign";

/**
 * Live VizChain read path, backed by viz-js-lib against an HTTP(S) or WS node
 * (e.g. https://node.viz.cx). Read-only methods need no keys; broadcastRelease
 * (the write path) is implemented in a later phase.
 *
 * Verified against node.viz.cx: getDynamicGlobalProperties.last_irreversible_block_num
 * trails head by ~14 blocks (~42s); getOpsInBlock returns
 *   { trx_id, block, op_in_trx, virtual_op, op:[name, payload] }
 * and a transfer payload is { from, to, amount:"X.XXX VIZ", memo }.
 */
const ZERO_TRX = "0000000000000000000000000000000000000000";

/**
 * Per-RPC deadline. viz-js-lib's HTTP transport has been observed to wedge after
 * upstream 502s (node.viz.cx is load-balanced with intermittently unhealthy
 * backends): the callback is never invoked, so a bare Promise around it never
 * settles and the scan loop stalls silently — no error, no progress, until the
 * process is restarted. Racing every call against this deadline turns a wedged
 * transport into a caught, logged error the loop retries on the next tick, so the
 * watcher self-heals from transient node failures instead of going dark.
 */
export const RPC_TIMEOUT_MS = 20_000;

/**
 * Bounded retry for TRANSIENT read failures. node.viz.cx is load-balanced across
 * intermittently unhealthy backends and returns sporadic HTTP 502/503/504 — and 429
 * (rate limit) once the coordinator + dispatcher + watcher all read the same node — and
 * the transport occasionally wedges → RPC_TIMEOUT_MS abort. Without a retry, a single
 * such blip anywhere in a MAX_BLOCKS_PER_SCAN sweep of getOpsInBlock rejects the
 * WHOLE window — the loop then restarts the same window from the same cursor, so
 * under a steady 502 rate the scan can churn for many minutes and never sweep past
 * a deposit inside the peg-in timeout (observed live: the lock was on-chain but the
 * mint never fired). Retrying the individual call lets a flaky node slow the scan
 * instead of resetting it. Only transient errors are retried — application errors
 * (operation_history's "unknown transaction" for an unconfirmed id) stay fast and
 * fail-closed for getDeposit / confirmReleaseByTxId.
 */
export const RPC_MAX_ATTEMPTS = 4;
export const RPC_RETRY_BASE_MS = 500;

/**
 * True for load-balancer/transport failures that a retry can clear: gateway 5xx,
 * 429 rate limits (exponential backoff is exactly the right response), socket
 * resets/timeouts, DNS blips, and our own RPC_TIMEOUT_MS abort. Deliberately does
 * NOT match application-level errors (e.g. "unknown transaction"), so a legit
 * not-found still returns promptly rather than after four backoffs.
 */
export function isTransientRpcError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /\b(429|50[234])\b|too many requests|bad gateway|service unavailable|gateway time-?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timed out after/i.test(
    msg,
  );
}

/**
 * Release-confirmation poll bound. The release is broadcast ASYNC (see broadcastRelease)
 * and confirmed by re-reading its exact id from the chain, because the synchronous
 * broadcast blocks until block inclusion — which node.viz.cx / its RPC proxy 504s (and
 * RPC_TIMEOUT_MS aborts) once inclusion lags past ~20s, making a legit release look
 * failed. ~60s of polling covers that inclusion lag; a still-unconfirmed release then
 * fails the round and is retried idempotently (confirmReleaseByTxId dedupes by id).
 */
export const RELEASE_CONFIRM_INTERVAL_MS = 3_000;
export const RELEASE_CONFIRM_POLLS = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Bound the per-call block scan so a watcher tick can't accidentally scan the
 * chain. Exported so the watcher advances its cursor only to what a single call
 * actually scanned (`min(safeHead, cursor + MAX_BLOCKS_PER_SCAN)`), never past it
 * — a backlog larger than the cap must not be silently skipped (VG-03).
 */
export const MAX_BLOCKS_PER_SCAN = 200;

/**
 * Defense-in-depth: a correct node echoes back the transaction_id we asked for. Throw if it
 * is MISSING or mismatched — an absent id (undefined/"") must NOT skip the check (fail-open),
 * or a lying/misbehaving node could return a different transfer under the requested trxId
 * (VG M7). Fail closed: we only derive a peg-in from a response we can tie to the exact trx.
 */
export function assertTransactionIdMatches(returnedId: string | undefined, requestedId: string): void {
  if (!returnedId || returnedId !== requestedId) {
    throw new Error(`getDeposit(${requestedId}): node returned transaction_id "${returnedId ?? ""}" != requested ${requestedId}`);
  }
}

/**
 * The block window a single watcher tick should scan+commit, given the current
 * cursor and safe head. `scannedTo` is capped at one MAX_BLOCKS_PER_SCAN stride so
 * a large backlog is caught over successive ticks rather than skipped (VG-03);
 * `caughtUp` is false while a backlog remains (the watcher then skips its sleep to
 * drain fast). Pure — shared by the watcher and its spike so they can't drift.
 */
export function nextScanWindow(cursor: number, safeHead: number): { scannedTo: number; caughtUp: boolean } {
  const scannedTo = Math.min(safeHead, cursor + MAX_BLOCKS_PER_SCAN);
  return { scannedTo, caughtUp: scannedTo >= safeHead };
}

function callOnce<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`viz RPC timed out after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);
    exec((err, res) => {
      if (settled) return; // late callback after a timeout — ignore
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(res);
    });
  });
}

/**
 * Every VIZ read/broadcast goes through here: one attempt (callOnce) plus bounded
 * retry on transient failures with exponential backoff (500/1000/2000ms). Safe for
 * the broadcast path too — the release id is deterministic and confirmReleaseByTxId
 * dedupes, so a re-sent transfer is a no-op on the chain.
 */
async function call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(exec);
    } catch (err) {
      lastErr = err;
      if (attempt === RPC_MAX_ATTEMPTS || !isTransientRpcError(err)) throw err;
      await sleep(RPC_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw lastErr; // unreachable: the loop either returns or throws on the last attempt
}

/** "189.027 VIZ" -> 189027n (integer milli-VIZ). VIZ assets always have 3 decimals. */
export function vizToMilli(amount: string): bigint {
  const numeric = amount.trim().split(" ")[0] ?? "0";
  const [intPart, fracPart = ""] = numeric.split(".");
  const frac = (fracPart + "000").slice(0, 3);
  return BigInt(intPart || "0") * 1000n + BigInt(frac || "0");
}

/** 189027n -> "189.027 VIZ". Inverse of vizToMilli. */
export function milliToViz(milli: bigint): string {
  const neg = milli < 0n;
  const v = neg ? -milli : milli;
  const int = v / 1000n;
  const frac = (v % 1000n).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${int.toString()}.${frac} VIZ`;
}

export class VizJsChain implements VizChain {
  constructor(nodeUrl: string, private readonly accounts: GatewayAccounts) {
    // viz-js-lib selects http/ws transport from the "websocket" config value;
    // it accepts http(s):// and ws(s):// URLs alike.
    viz.config.set("websocket", nodeUrl);
  }

  async lastIrreversibleBlock(): Promise<number> {
    const gp = await call<DynamicGlobalProperties>((cb) =>
      viz.api.getDynamicGlobalProperties(cb),
    );
    return gp.last_irreversible_block_num;
  }

  async irreversibleDepositsSince(fromBlock: number, upToBlock: number): Promise<VizDeposit[]> {
    const start = fromBlock + 1;
    if (upToBlock < start) return [];
    const end = Math.min(upToBlock, start + MAX_BLOCKS_PER_SCAN - 1);

    const deposits: VizDeposit[] = [];
    for (let b = start; b <= end; b++) {
      const ops = await call<OpWrapper[]>((cb) => viz.api.getOpsInBlock(b, false, cb));
      for (const w of ops ?? []) {
        if (w.virtual_op !== 0) continue; // skip virtual ops (rewards etc.)
        if (w.trx_id === ZERO_TRX) continue; // belt-and-suspenders
        const [name, payload] = w.op;
        if (name !== "transfer") continue;
        const to = String(payload["to"] ?? "");
        if (!this.accounts.isBackingAccount(to)) continue;
        const chain = this.accounts.chainFor(to);
        const destination = String(payload["memo"] ?? "").trim();
        try {
          // Memo is the raw remote address; the chain is determined by the receiving account.
          // Reject empty memos, colons, and malformed addresses for this chain.
          validateRemoteAddress(chain, destination);
        } catch (err) {
          // Malformed destination: not a valid peg-in target. Skip and warn
          // (flag for manual refund); never silently default the destination chain.
          console.warn(`[viz-chain] skipping deposit ${w.trx_id}:${w.op_in_trx}: ${String(err)}`);
          continue;
        }
        deposits.push({
          trxId: w.trx_id,
          opIndex: w.op_in_trx,
          blockNum: w.block,
          from: String(payload["from"] ?? ""),
          to,
          amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
          remoteChain: chain,
          remoteDestination: destination,
        });
      }
    }
    return deposits;
  }

  /**
   * F2 source re-validation: fetch ONE confirmed transfer op by (trxId, opIndex)
   * and reconstruct the VizDeposit, exactly as irreversibleDepositsSince would.
   * This is the signer's independent read of the peg-in source event — it must
   * use the operator's OWN node, never a coordinator-fed value.
   *
   * Fail-closed: returns null if the trx is unknown OR not yet irreversible (the
   * caller then refuses to sign — worst case a liveness stall). Throws only on a
   * structural violation (no such op, or the op is not a transfer to the gateway),
   * which signals a coordinator referencing a source event that doesn't match.
   */
  async getDeposit(trxId: string, opIndex: number): Promise<VizDeposit | null> {
    let tx: AnnotatedTransaction | null;
    try {
      tx = await call<AnnotatedTransaction | null>((cb) => viz.api.getTransaction(trxId, cb));
    } catch (err) {
      // operation_history returns an error for an unknown trx id; treat as not-found
      // (fail-closed). A transport failure also lands here and correctly refuses.
      console.warn(`[viz-chain] getDeposit(${trxId}): lookup failed: ${String(err)}`);
      return null;
    }
    if (!tx || !Array.isArray(tx.operations)) return null;

    // Defense-in-depth: a correct node echoes the id we asked for. Missing OR mismatched =>
    // refuse to derive from it (an empty id must not skip the check — see M7).
    assertTransactionIdMatches(tx.transaction_id, trxId);

    // Confirm the transfer is irreversible before trusting it (re-org safety).
    const lib = await this.lastIrreversibleBlock();
    if (tx.block_num > lib) return null;

    const op = tx.operations[opIndex];
    if (!op) {
      throw new Error(`getDeposit(${trxId}:${opIndex}): no op at index ${opIndex}`);
    }
    const [name, payload] = op;
    if (name !== "transfer") {
      throw new Error(`getDeposit(${trxId}:${opIndex}): op is "${name}", not a transfer`);
    }
    const to = String(payload["to"] ?? "");
    if (!this.accounts.isBackingAccount(to)) {
      throw new Error(
        `getDeposit(${trxId}:${opIndex}): transfer "to" (${to}) is not a backing account`,
      );
    }
    const chain = this.accounts.chainFor(to);
    const destination = String(payload["memo"] ?? "").trim();
    // Throws on empty, colon-containing, or format-invalid address (no silent default).
    validateRemoteAddress(chain, destination);
    return {
      trxId,
      opIndex,
      blockNum: tx.block_num,
      from: String(payload["from"] ?? ""),
      to,
      amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
      remoteChain: chain,
      remoteDestination: destination,
    };
  }

  async gatewayBalanceMilliViz(account: string): Promise<bigint> {
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([account], cb));
    const acct = accounts?.[0];
    if (!acct) return 0n;
    return vizToMilli(acct.balance);
  }

  /** getAccounts returns only existing accounts, so a present row means it exists. */
  async accountExists(name: string): Promise<boolean> {
    if (!name) return false;
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([name], cb));
    return Boolean(accounts?.[0]);
  }

  /**
   * The gateway account's active-authority weight_threshold — i.e. how many
   * equal-weight operator signatures a transfer needs to be valid. The federation
   * may collect MORE approvals than this (its own threshold can exceed the VIZ
   * account's, e.g. when the same operator set also signs a higher-threshold remote
   * authority), and VIZ rejects a transfer that carries a signature beyond its
   * minimal satisfying set ("irrelevant signature included"). broadcastRelease uses
   * this to attach exactly the required number of signatures.
   */
  async activeWeightThreshold(account: string): Promise<number> {
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([account], cb));
    const threshold = accounts?.[0]?.active_authority?.weight_threshold;
    if (!threshold || threshold < 1) {
      throw new Error(`activeWeightThreshold(${account}): no active authority found`);
    }
    return threshold;
  }

  /**
   * Build the shared release proposal: a deterministic transfer skeleton with
   * fixed TaPoS (from the current head) and expiration. The coordinator builds
   * this once and distributes it; every operator signs these exact bytes.
   */
  async buildReleaseProposal(
    action: CanonicalAction,
    gatewayAccount: string,
  ): Promise<VizReleaseProposal> {
    const gp = await call<DynamicGlobalProperties>((cb) =>
      viz.api.getDynamicGlobalProperties(cb),
    );
    // TaPoS: low 16 bits of head block number + bytes 4..8 of the head block id.
    const refBlockNum = gp.head_block_number & 0xffff;
    const refBlockPrefix = Buffer.from(gp.head_block_id, "hex").readUInt32LE(4);
    const expiration = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
    return {
      refBlockNum,
      refBlockPrefix,
      expiration,
      from: gatewayAccount,
      to: action.recipient,
      amount: milliToViz(action.amountMilliViz),
      memo: action.id,
    };
  }

  /**
   * The deterministic transaction id for a release proposal (computed locally, no RPC).
   * The coordinator persists this BEFORE broadcasting so recovery can confirm by exact id.
   */
  transactionId(proposal: VizReleaseProposal): string {
    return releaseTxId(proposal);
  }

  /**
   * Confirm a specific release landed on-chain by its EXACT transaction id — an O(1)
   * lookup with no scan window (replaces the old last-1000-ops memo scan, which could
   * miss an older release on a busy gateway and re-broadcast a second real transfer).
   * Returns `{ txid }` if the node knows the tx, else null (unknown id => never landed).
   */
  async confirmReleaseByTxId(txid: string): Promise<{ txid: string } | null> {
    if (!txid) return null;
    try {
      const tx = await call<AnnotatedTransaction | null>((cb) => viz.api.getTransaction(txid, cb));
      return tx ? { txid } : null;
    } catch {
      // operation_history errors for an unknown id; treat as not-found (never broadcast).
      return null;
    }
  }

  /**
   * Attach the >= T merged signatures (order-independent) and broadcast.
   *
   * ASYNC broadcast + poll (NOT broadcastTransactionSynchronous): the synchronous
   * variant blocks until block inclusion, which node.viz.cx's RPC proxy 504s / the
   * RPC_TIMEOUT_MS deadline aborts once inclusion lags past ~20s — a legit release then
   * looks failed and the dispatcher retries it. broadcastTransaction returns as soon as
   * the trx is accepted into the pending pool; the chain (not the ack) confirms it, so
   * we poll confirmReleaseByTxId for the deterministic id. Mirrors tools/topup-tester3.cjs.
   *
   * Idempotent: the id is a pure function of the proposal (independent of signatures),
   * and confirmReleaseByTxId dedupes by exact id — so a release that lands after the
   * poll window is caught by the coordinator's actionExecuted check on the next retry
   * rather than re-broadcast.
   */
  async broadcastRelease(proposal: VizReleaseProposal, signatures: string[]): Promise<string> {
    if (signatures.length === 0) throw new Error("no signatures to broadcast");
    const tx = buildReleaseTx(proposal);
    // VIZ rejects a transfer carrying more signatures than its active authority's
    // minimal satisfying set ("irrelevant signature included"), and an ASYNC broadcast
    // does not surface that apply-time rejection — the release just never lands. The
    // federation can collect more approvals (its threshold) than the gateway account's
    // active weight_threshold, so attach exactly the required number. Operator keys are
    // equal-weight (weight 1), so any `weight_threshold` of the collected signatures
    // form a valid minimal set.
    const required = await this.activeWeightThreshold(proposal.from);
    if (signatures.length < required) {
      throw new Error(
        `broadcastRelease(${proposal.from}): have ${signatures.length} signatures, authority needs ${required}`,
      );
    }
    tx.signatures = signatures.slice(0, required);
    const txid = releaseTxId(proposal); // deterministic; equals the on-chain id
    let broadcastErr = "";
    try {
      await call<BroadcastResult>((cb) => viz.api.broadcastTransaction(tx, cb));
    } catch (err) {
      // An async broadcast can still land even when the HTTP call errors (proxy hiccup,
      // or a duplicate-in-pool rejection after a prior attempt already queued it), so we
      // let the poll below decide by exact id rather than failing prematurely. But we keep
      // the reason: if the poll never confirms, a genuine rejection (bad signature,
      // expired TaPoS) should surface here, not be masked by a generic "not confirmed".
      broadcastErr = String(err);
      console.warn(`[viz-chain] broadcastTransaction(${txid}) errored (polling for inclusion anyway): ${broadcastErr}`);
    }
    for (let i = 0; i < RELEASE_CONFIRM_POLLS; i++) {
      await sleep(RELEASE_CONFIRM_INTERVAL_MS);
      if (await this.confirmReleaseByTxId(txid)) return txid;
    }
    const secs = (RELEASE_CONFIRM_POLLS * RELEASE_CONFIRM_INTERVAL_MS) / 1000;
    throw new Error(
      `viz release ${txid} not confirmed after ${secs}s${broadcastErr ? ` (broadcast error: ${broadcastErr})` : ""}`,
    );
  }
}
