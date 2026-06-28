import viz, {
  type Account,
  type AnnotatedTransaction,
  type BroadcastResult,
  type DynamicGlobalProperties,
  type OpWrapper,
} from "viz-js-lib";
import {
  parseRemoteTarget,
  type CanonicalAction,
  type RemoteChainId,
  type VizChain,
  type VizDeposit,
  type VizReleaseProposal,
} from "@gateway/common";
import { buildReleaseTx } from "./vizSign";

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

/** Bound the per-call block scan so a watcher tick can't accidentally scan the chain. */
const MAX_BLOCKS_PER_SCAN = 200;

function call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    exec((err, res) => (err ? reject(err) : resolve(res)));
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
  constructor(nodeUrl: string, private readonly gatewayAccount: string) {
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
        if (payload["to"] !== this.gatewayAccount) continue;
        const memo = String(payload["memo"] ?? "");
        let target: { chain: RemoteChainId; destination: string };
        try {
          // Memo is "<chain>:<address>"; the target chain is committed in the digest.
          // Remote address-format validation happens before signing (signer-side).
          target = parseRemoteTarget(memo);
        } catch (err) {
          // Unparseable/prefixless memo: not a valid peg-in target. Skip and warn
          // (flag for manual refund); never silently default the destination chain.
          console.warn(`[viz-chain] skipping deposit ${w.trx_id}:${w.op_in_trx}: ${String(err)}`);
          continue;
        }
        deposits.push({
          trxId: w.trx_id,
          opIndex: w.op_in_trx,
          blockNum: w.block,
          from: String(payload["from"] ?? ""),
          to: String(payload["to"] ?? ""),
          amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
          remoteChain: target.chain,
          remoteDestination: target.destination,
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

    // Defense-in-depth: a correct node echoes the id we asked for. A mismatch means a
    // misbehaving/lying node returned a different transaction — refuse to derive from it.
    if (tx.transaction_id && tx.transaction_id !== trxId) {
      throw new Error(
        `getDeposit(${trxId}): node returned transaction_id ${tx.transaction_id} != requested ${trxId}`,
      );
    }

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
    if (payload["to"] !== this.gatewayAccount) {
      throw new Error(
        `getDeposit(${trxId}:${opIndex}): transfer "to" (${String(payload["to"])}) != gateway ${this.gatewayAccount}`,
      );
    }
    // Memo "<chain>:<address>"; throws on a missing/unknown prefix (no silent default).
    const target = parseRemoteTarget(String(payload["memo"] ?? ""));
    return {
      trxId,
      opIndex,
      blockNum: tx.block_num,
      from: String(payload["from"] ?? ""),
      to: String(payload["to"] ?? ""),
      amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
      remoteChain: target.chain,
      remoteDestination: target.destination,
    };
  }

  async gatewayBalanceMilliViz(): Promise<bigint> {
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([this.gatewayAccount], cb));
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
   * Scan recent gateway-account transfer history for an outgoing transfer whose memo
   * equals `memo` (= CanonicalAction.id). Used by the coordinator's idempotency check
   * to detect a VIZ release that landed on-chain after a crash.
   * Scans the last 1000 ops; if the release is older it will be missed and the action
   * re-broadcast (durable-nonce expiry applies — worst case an on-chain duplicate-trx
   * rejection, which is safe). Returns null if not found.
   */
  async releaseByMemo(memo: string): Promise<{ txid: string } | null> {
    type HistoryItem = { trx_id: string; op: [string, Record<string, unknown>] };
    // viz-js-lib types omit getAccountHistory; cast to any to invoke it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiAny = viz.api as unknown as Record<string, (...args: unknown[]) => void>;
    const history = await call<Array<[number, HistoryItem]>>(
      (cb) => apiAny["getAccountHistory"]!(this.gatewayAccount, -1, 1000, cb),
    );
    for (const [, item] of history ?? []) {
      const [name, payload] = item.op;
      if (name !== "transfer") continue;
      if (payload["from"] !== this.gatewayAccount) continue;
      if (payload["memo"] === memo) return { txid: item.trx_id };
    }
    return null;
  }

  /** Attach the >= T merged signatures (order-independent) and broadcast. */
  async broadcastRelease(proposal: VizReleaseProposal, signatures: string[]): Promise<string> {
    if (signatures.length === 0) throw new Error("no signatures to broadcast");
    const tx = buildReleaseTx(proposal);
    tx.signatures = signatures;
    const res = await call<BroadcastResult>((cb) =>
      viz.api.broadcastTransactionSynchronous(tx, cb),
    );
    return res.id ?? "";
  }
}
