// tools/e2e/viz.ts — minimal VIZ client for the e2e harness (lock submit + balance).
import viz from "viz-js-lib";
import type { E2eConfig } from "./config";

// Tiny amount helpers copied (not imported) to keep the harness free of a
// watcher dependency. "X.XXX VIZ" <-> integer milli-VIZ.
export function vizToMilli(amount: string): bigint {
  const parts = amount.replace(/\s*VIZ$/i, "").split(".");
  const whole = parts[0] ?? "0";
  const frac = ((parts[1] ?? "") + "000").slice(0, 3);
  return BigInt(whole) * 1000n + BigInt(frac);
}
export function milliToViz(milli: bigint): string {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, "0");
  return `${whole}.${frac} VIZ`;
}

function call<T>(fn: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, res) => (err ? reject(err) : resolve(res))),
  );
}

function setTransport(nodeUrl: string) {
  // viz-js-lib accepts both http(s):// and ws(s):// from the "websocket" key.
  viz.config.set("websocket", nodeUrl);
}

export async function vizBalanceMilliViz(nodeUrl: string, account: string): Promise<bigint> {
  setTransport(nodeUrl);
  const accts = await call<Array<{ balance: string }>>((cb) =>
    viz.api.getAccounts([account], cb),
  );
  if (!accts || accts.length === 0) return 0n;
  return vizToMilli(accts[0]!.balance);
}

/** True iff the VIZ account exists (get_accounts returns a row). */
export async function vizAccountExists(nodeUrl: string, account: string): Promise<boolean> {
  setTransport(nodeUrl);
  const accts = await call<Array<{ name?: string }>>((cb) => viz.api.getAccounts([account], cb));
  return Boolean(accts && accts.length > 0 && accts[0]);
}

export async function submitLock(cfg: E2eConfig, grossMilliViz: bigint, memo: string): Promise<string> {
  setTransport(cfg.viz.nodeUrl);
  const gp = await call<{ head_block_number: number; head_block_id: string }>((cb) =>
    viz.api.getDynamicGlobalProperties(cb),
  );
  // TaPoS: low 16 bits of head block number + bytes 4..8 of the head block id.
  const refBlockNum = gp.head_block_number & 0xffff;
  const refBlockPrefix = Buffer.from(gp.head_block_id, "hex").readUInt32LE(4);
  const expiration = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
  const tx = {
    ref_block_num: refBlockNum,
    ref_block_prefix: refBlockPrefix,
    expiration,
    operations: [
      ["transfer", { from: cfg.viz.testAccount, to: cfg.viz.gatewayAccount, amount: milliToViz(grossMilliViz), memo }],
    ] as Array<[string, Record<string, unknown>]>,
    extensions: [] as unknown[],
  };
  const signed = viz.auth.signTransaction(tx, [cfg.viz.testWif]);
  const res = await call<{ id?: string; block_num?: number }>((cb) =>
    viz.api.broadcastTransactionSynchronous(signed, cb),
  );
  return res.id ?? "(no id)";
}
