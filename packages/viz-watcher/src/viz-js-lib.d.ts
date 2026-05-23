// Minimal ambient typings for the (untyped) viz-js-lib, covering only the
// surface this package uses. Expand as more of the API gets wired.
declare module "viz-js-lib" {
  type Cb<T> = (err: unknown, res: T) => void;

  export interface DynamicGlobalProperties {
    head_block_number: number;
    head_block_id: string;
    last_irreversible_block_num: number;
    time: string;
  }

  /** A VIZ transaction object (operations are [name, payload] tuples). */
  export interface VizTransaction {
    ref_block_num: number;
    ref_block_prefix: number;
    expiration: string;
    operations: Array<[string, Record<string, unknown>]>;
    extensions: unknown[];
    signatures?: string[];
  }

  export interface BroadcastResult {
    id?: string;
    block_num?: number;
  }

  export interface OpWrapper {
    trx_id: string;
    block: number;
    trx_in_block: number;
    op_in_trx: number;
    virtual_op: number;
    timestamp: string;
    /** [opName, payload] */
    op: [string, Record<string, unknown>];
  }

  export interface Account {
    name: string;
    balance: string; // e.g. "189.027 VIZ"
  }

  interface VizApi {
    getDynamicGlobalProperties(cb: Cb<DynamicGlobalProperties>): void;
    getOpsInBlock(blockNum: number, onlyVirtual: boolean, cb: Cb<OpWrapper[]>): void;
    getAccounts(names: string[], cb: Cb<Account[]>): void;
    broadcastTransactionSynchronous(trx: VizTransaction, cb: Cb<BroadcastResult>): void;
  }

  interface VizConfig {
    set(key: string, value: string): void;
    get(key: string): unknown;
  }

  interface VizAuth {
    /** Appends a signature per key to trx.signatures over chain_id + toBuffer(trx). */
    signTransaction(trx: VizTransaction, keys: string[]): VizTransaction;
    wifToPublic(wif: string): string;
  }

  interface Viz {
    api: VizApi;
    config: VizConfig;
    auth: VizAuth;
  }

  const viz: Viz;
  export default viz;
}
