import viz, {
  type Account,
  type BroadcastResult,
  type DynamicGlobalProperties,
  type OpWrapper,
} from "viz-js-lib";
import type { CanonicalAction, VizChain, VizDeposit, VizReleaseProposal } from "@gateway/common";
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
        deposits.push({
          trxId: w.trx_id,
          opIndex: w.op_in_trx,
          blockNum: w.block,
          from: String(payload["from"] ?? ""),
          to: String(payload["to"] ?? ""),
          amountMilliViz: vizToMilli(String(payload["amount"] ?? "0.000 VIZ")),
          // The transfer memo carries the user's TON destination. Validation of
          // the TON address format happens before signing (signer-side).
          tonDestination: String(payload["memo"] ?? "").trim(),
        });
      }
    }
    return deposits;
  }

  async gatewayBalanceMilliViz(): Promise<bigint> {
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([this.gatewayAccount], cb));
    const acct = accounts?.[0];
    if (!acct) return 0n;
    return vizToMilli(acct.balance);
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
