import viz, {
  type Account,
  type AnnotatedTransaction,
  type BroadcastResult,
  type DynamicGlobalProperties,
  type OpWrapper,
  type VizBlock,
  type VizTransaction,
} from "viz-js-lib";
// Internal serializer + hash: recompute a transaction's graphene id from the block-log
// tx (get_block carries no transaction_ids). git-pinned; paths stable for this version.
import { transaction as txSerializer } from "viz-js-lib/lib/auth/serializer/src/operations";
import { sha256 } from "viz-js-lib/lib/auth/ecc/src/hash";
import {
  isValidRemoteAddress,
  GatewayAccounts,
  type CanonicalAction,
  type VizChain,
  type VizDeposit,
  type VizReleaseProposal,
} from "@gateway/common";
import { buildReleaseTx, releaseTxId, selectAuthoritySignatures, type VizAuthority } from "./vizSign";
import { resolveMemoDestination } from "./memo";

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

/** Normalize the node argument to a non-empty list; a bare string becomes a singleton. */
function normalizeNodeUrls(nodeUrls: string | string[]): string[] {
  const list = (Array.isArray(nodeUrls) ? nodeUrls : [nodeUrls]).map((u) => u.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("VizJsChain: at least one node URL is required");
  return list;
}

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
 * The graphene transaction id: sha256 of the serialized UNSIGNED transaction, first
 * 20 bytes, hex. `get_block` returns each transaction's operations+signatures but NO
 * transaction_id (transaction_ids is null), so to bind a block-log tx to a requested
 * trxId the signer MUST recompute it here — otherwise the coordinator would control the
 * trxId↔transaction mapping (a real transfer could be re-pointed to a fabricated trxId).
 * The `transaction` serializer excludes signatures; chain_id is prepended ONLY for signing
 * (Auth.signTransaction), NOT for the id. PROVEN 2026-07-28 against the incident tx
 * (golden vector in the unit test) and live via tools/refund-getblock-spike.cjs.
 */
export function computeTrxId(tx: VizTransaction): string {
  const buf = txSerializer.toBuffer({
    ref_block_num: tx.ref_block_num,
    ref_block_prefix: tx.ref_block_prefix,
    expiration: tx.expiration,
    operations: tx.operations,
    extensions: tx.extensions ?? [],
  });
  return sha256(buf).subarray(0, 20).toString("hex");
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
  /**
   * The node list this instance fails over across, and the sticky index of the node
   * currently selected on the (process-global) viz singleton. Idempotent reads and the
   * deterministic-id broadcast are safe to retry on a rotated node.
   */
  private readonly nodeUrls: string[];
  private idx = 0;

  /**
   * @param nodeUrls  one node URL or a failover list (VIZ_NODE_URL, comma/whitespace split).
   *   On a TRANSIENT RPC error `call()` advances to the next node (viz.config is a process-
   *   global singleton, so failover re-sets it per attempt rather than holding N instances)
   *   and retries; the index is sticky across calls so a healthy node keeps serving once found.
   *   A single URL preserves today's behaviour exactly (4 attempts, same node).
   * @param memoWifs  per-gate-account memo private keys (WIF), keyed by account name,
   *   for decrypting `#`-encrypted peg-in memos. Omit (or leave empty) to keep the
   *   historical plaintext-only behaviour — an encrypted memo then fails validation
   *   and auto-refunds. MUST match across all operators (see resolveMemoDestination).
   */
  constructor(
    nodeUrls: string | string[],
    private readonly accounts: GatewayAccounts,
    private readonly memoWifs: Record<string, string> = {},
  ) {
    this.nodeUrls = normalizeNodeUrls(nodeUrls);
    // viz-js-lib selects http/ws transport from the "websocket" config value;
    // it accepts http(s):// and ws(s):// URLs alike.
    viz.config.set("websocket", this.nodeUrls[0]!);
  }

  /**
   * Every VIZ read/broadcast goes through here: one attempt (callOnce) plus bounded retry on
   * transient failures with exponential backoff (500/1000/2000ms). On a transient failure that
   * is not the final attempt, rotate to the NEXT node in the list before retrying — a single
   * node's 5xx/timeout/rate-limit spike then fails over instead of latching (the recon
   * false-pause that motivated this). Rotation touches the process-global viz.config singleton;
   * concurrent in-flight reads on this instance share it, which is benign for idempotent reads
   * and the deterministic-id broadcast (confirmReleaseByTxId dedupes a re-sent transfer).
   * Non-transient (application) errors still throw immediately WITHOUT rotating — fail-closed,
   * exactly as before, so a genuine "unknown transaction" stays fast.
   */
  private async call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
      try {
        return await callOnce(exec);
      } catch (err) {
        lastErr = err;
        if (attempt === RPC_MAX_ATTEMPTS || !isTransientRpcError(err)) throw err;
        if (this.nodeUrls.length > 1) {
          this.idx = (this.idx + 1) % this.nodeUrls.length;
          viz.config.set("websocket", this.nodeUrls[this.idx]!);
        }
        await sleep(RPC_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr; // unreachable: the loop either returns or throws on the last attempt
  }

  /**
   * Resolve the transfer memo to a destination address, decrypting an encrypted
   * memo when we hold this account's memo key. Shared by the reader and the
   * signer's F2 re-read so the two paths cannot drift.
   */
  private resolveDestination(account: string, rawMemo: string): string {
    return resolveMemoDestination(rawMemo, this.memoWifs[account]);
  }

  async lastIrreversibleBlock(): Promise<number> {
    const gp = await this.call<DynamicGlobalProperties>((cb) =>
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
      const ops = await this.call<OpWrapper[]>((cb) => viz.api.getOpsInBlock(b, false, cb));
      for (const w of ops ?? []) {
        if (w.virtual_op !== 0) continue; // skip virtual ops (rewards etc.)
        if (w.trx_id === ZERO_TRX) continue; // belt-and-suspenders
        const [name, payload] = w.op;
        if (name !== "transfer") continue;
        const to = String(payload["to"] ?? "");
        if (!this.accounts.isBackingAccount(to)) continue;
        const chain = this.accounts.chainFor(to);
        const rawMemo = String(payload["memo"] ?? "").trim();
        // The memo carries the remote address; the chain is determined by the receiving
        // account. An encrypted ('#'-prefixed) memo is decrypted here when we hold this
        // account's memo key — otherwise (and for plaintext) the string passes through.
        // A missing/malformed/undecryptable memo is NOT dropped (that stranded funds —
        // 2026-07-15 incident): reconstruct the deposit flagged destinationValid=false and
        // canonicalize the destination to the "" sentinel, so the watcher can enqueue it for
        // auto-refund while the signer keeps it un-mintable. A valid address flows through as before.
        const rawDestination = this.resolveDestination(to, rawMemo);
        const destinationValid = isValidRemoteAddress(chain, rawDestination);
        if (!destinationValid) {
          // Log the RAW memo (ciphertext or already-invalid plaintext), never a decrypted address.
          console.warn(
            `[viz-chain] deposit ${w.trx_id}:${w.op_in_trx} has invalid/empty/undecryptable destination memo "${rawMemo}" -> flag for auto-refund`,
          );
        }
        deposits.push({
          trxId: w.trx_id,
          opIndex: w.op_in_trx,
          blockNum: w.block,
          from: String(payload["from"] ?? ""),
          to,
          amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
          remoteChain: chain,
          remoteDestination: destinationValid ? rawDestination : "",
          destinationValid,
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
  async getDeposit(trxId: string, opIndex: number, blockNumHint?: number): Promise<VizDeposit | null> {
    // PRIMARY: operation_history.get_transaction. Works for timely refunds (the common
    // case). On success this is unchanged behaviour.
    let tx: AnnotatedTransaction | null = null;
    try {
      tx = await this.call<AnnotatedTransaction | null>((cb) => viz.api.getTransaction(trxId, cb));
    } catch (err) {
      // operation_history returns an error for an unknown trx id (also fires once the
      // block ages past the node's history retention). A transport failure also lands
      // here. Fall through to the block-log fallback if we have a hint; else fail-closed.
      console.warn(`[viz-chain] getDeposit(${trxId}): operation_history lookup failed: ${String(err)}`);
    }
    if (tx && Array.isArray(tx.operations)) {
      // Defense-in-depth: a correct node echoes the id we asked for. Missing OR mismatched =>
      // refuse to derive from it (an empty id must not skip the check — see M7).
      assertTransactionIdMatches(tx.transaction_id, trxId);
      // Confirm the transfer is irreversible before trusting it (re-org safety).
      const lib = await this.lastIrreversibleBlock();
      if (tx.block_num > lib) return null;
      return this.depositFromOps(trxId, opIndex, tx.block_num, tx.operations);
    }

    // FALLBACK: the history index can't serve this parent (pruned — the block aged past
    // every node's operation_history retention). The raw block LOG survives that pruning,
    // so re-read the deposit from get_block(blockNumHint) and recompute the trx id to bind
    // it trustlessly. The hint is UNTRUSTED (coordinator/file out-of-band): security rests
    // on reading the block from the operator's OWN node and matching the recomputed id, so a
    // lying hint just fails the lookup. Only taken when a hint is present (no hint => today's
    // fail-closed null).
    if (blockNumHint !== undefined && Number.isInteger(blockNumHint) && blockNumHint > 0) {
      return this.getDepositViaBlock(trxId, opIndex, blockNumHint);
    }
    return null;
  }

  /**
   * Block-log fallback for getDeposit. Rotates across ALL configured nodes: an empty block,
   * a get_block error, or a block whose recomputed tx ids don't include `trxId` means THIS
   * node can't confirm (its block log is pruned/lagging) — NOT an authoritative not-found —
   * so try the next node (same lesson as the recon empty-backing false-pause). Returns null
   * only when EVERY node fails to confirm (fail-closed preserved). Throws on a structural
   * violation (the matched tx has no transfer op at opIndex / not a backing account), which
   * the source validator normalizes to SourceMismatchError.
   */
  private async getDepositViaBlock(trxId: string, opIndex: number, blockNum: number): Promise<VizDeposit | null> {
    for (let i = 0; i < this.nodeUrls.length; i++) {
      const nodeIdx = (this.idx + i) % this.nodeUrls.length;
      const nodeUrl = this.nodeUrls[nodeIdx]!;
      viz.config.set("websocket", nodeUrl);
      let block: VizBlock | null;
      try {
        block = await callOnce<VizBlock | null>((cb) => viz.api.getBlock(blockNum, cb));
      } catch (err) {
        console.warn(`[viz-chain] getDeposit(${trxId}): get_block(${blockNum}) on ${nodeUrl} failed: ${String(err)} — trying next node`);
        continue;
      }
      const txs = block?.transactions ?? [];
      // Recompute each tx id (get_block carries no transaction_ids) and find the match.
      // A malformed tx that fails to serialize is skipped, never fatal to the scan.
      const match = txs.find((t) => {
        try {
          return computeTrxId(t) === trxId;
        } catch {
          return false;
        }
      });
      if (!match) continue; // this node's block log can't confirm — try next

      // Irreversibility gate (re-org safety), read from the SAME node that served the block.
      let lib: number;
      try {
        const gp = await callOnce<DynamicGlobalProperties>((cb) => viz.api.getDynamicGlobalProperties(cb));
        lib = gp.last_irreversible_block_num;
      } catch (err) {
        console.warn(`[viz-chain] getDeposit(${trxId}): LIB read on ${nodeUrl} failed: ${String(err)} — trying next node`);
        continue;
      }
      if (blockNum > lib) {
        console.warn(`[viz-chain] getDeposit(${trxId}): block ${blockNum} > LIB ${lib} on ${nodeUrl} — not yet irreversible`);
        continue; // another node may be further along; else exhausted -> null (fail-closed)
      }

      this.idx = nodeIdx; // pin the node that could serve the archive read
      return this.depositFromOps(trxId, opIndex, blockNum, match.operations);
    }
    console.warn(`[viz-chain] getDeposit(${trxId}): no configured node could confirm block ${blockNum} (fail-closed)`);
    return null;
  }

  /**
   * Reconstruct a VizDeposit from a transfer op — the shared tail of BOTH the
   * operation_history path and the block-log fallback, so the two cannot drift on memo
   * resolution / destinationValid. Decrypts an encrypted memo with this account's memo key
   * (deterministic — all signers holding the key reproduce the identical destination, hence
   * the identical digest; a signer without it resolves "" and refuses, a liveness stall not
   * a wrong mint). The destination SHAPE does not throw here: a no-memo deposit is
   * reconstructed with destinationValid=false + the "" sentinel so the auto-refund path can
   * return it; the mint-validation layer (signer/validatePegIn) re-instates the never-mint
   * guarantee. Structural violations (no op / not a transfer / not a backing account) throw.
   */
  private depositFromOps(
    trxId: string,
    opIndex: number,
    blockNum: number,
    ops: Array<[string, Record<string, unknown>]>,
  ): VizDeposit {
    const op = ops[opIndex];
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
    const rawMemo = String(payload["memo"] ?? "").trim();
    const rawDestination = this.resolveDestination(to, rawMemo);
    const destinationValid = isValidRemoteAddress(chain, rawDestination);
    return {
      trxId,
      opIndex,
      blockNum,
      from: String(payload["from"] ?? ""),
      to,
      amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
      remoteChain: chain,
      remoteDestination: destinationValid ? rawDestination : "",
      destinationValid,
    };
  }

  async gatewayBalanceMilliViz(account: string): Promise<bigint> {
    const accounts = await this.call<Account[]>((cb) => viz.api.getAccounts([account], cb));
    const acct = accounts?.[0];
    // A backing account always exists on-chain, so a MISSING row here is an anomalous read
    // (an empty getAccounts result — a partial/lagging node reply that isn't a transport error,
    // so `call` never rotated), NOT a real zero balance. Returning 0n let recon read phantom
    // under-backing and false-pause the gateway (2026-07-28 incident: locked=0 while gram.gate
    // held 43.5k VIZ). Throw so recon treats it as INDETERMINATE (check() returns null → no
    // pause, consecutive-failure counter tracks it) rather than as a fatal zero.
    if (!acct) throw new Error(`gatewayBalanceMilliViz: backing account ${account} not found (empty getAccounts read)`);
    return vizToMilli(acct.balance);
  }

  /** getAccounts returns only existing accounts, so a present row means it exists. */
  async accountExists(name: string): Promise<boolean> {
    if (!name) return false;
    const accounts = await this.call<Account[]>((cb) => viz.api.getAccounts([name], cb));
    return Boolean(accounts?.[0]);
  }

  /**
   * The gateway account's active authority (weight_threshold + key_auths). The federation
   * may collect MORE approvals than this authority needs (its own threshold can exceed the
   * VIZ account's, e.g. when the same operator set also signs a higher-threshold remote
   * authority), and VIZ rejects a transfer that carries a signature beyond its minimal
   * satisfying set ("irrelevant signature included"). broadcastRelease reads this to pick
   * exactly the signatures whose keys are in key_auths, up to weight_threshold.
   */
  async activeAuthority(account: string): Promise<VizAuthority> {
    const accounts = await this.call<Account[]>((cb) => viz.api.getAccounts([account], cb));
    const auth = accounts?.[0]?.active_authority;
    if (!auth || !auth.weight_threshold || auth.weight_threshold < 1) {
      throw new Error(`activeAuthority(${account}): no active authority found`);
    }
    return { weight_threshold: auth.weight_threshold, key_auths: auth.key_auths };
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
    const gp = await this.call<DynamicGlobalProperties>((cb) =>
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
      const tx = await this.call<AnnotatedTransaction | null>((cb) => viz.api.getTransaction(txid, cb));
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
    // VIZ rejects a transfer carrying more signatures than its active authority's minimal
    // satisfying set ("irrelevant signature included"), and an ASYNC broadcast does not
    // surface that apply-time rejection — the release just never lands. The federation can
    // collect more approvals than the gateway account's authority needs, so attribute each
    // signature to its key via recovery and keep only a minimal in-authority subset (never
    // trusting collection order — robust to a federation/authority mismatch during rotation).
    // Throws fail-closed if the relevant signatures can't reach the threshold.
    const authority = await this.activeAuthority(proposal.from);
    tx.signatures = selectAuthoritySignatures(proposal, signatures, authority);
    const txid = releaseTxId(proposal); // deterministic; equals the on-chain id
    let broadcastErr = "";
    try {
      await this.call<BroadcastResult>((cb) => viz.api.broadcastTransaction(tx, cb));
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
