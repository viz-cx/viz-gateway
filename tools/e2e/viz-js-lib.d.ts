// Minimal ambient typings for viz-js-lib, covering the surface the e2e harness uses.
declare module "viz-js-lib" {
  type Cb<T> = (err: unknown, res: T) => void;

  export interface Account {
    name: string;
    balance: string; // e.g. "189.027 VIZ"
  }

  export interface DynamicGlobalProperties {
    head_block_number: number;
    head_block_id: string;
    last_irreversible_block_num: number;
    time: string;
  }

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

  interface VizApi {
    getAccounts(names: string[], cb: Cb<Account[]>): void;
    getDynamicGlobalProperties(cb: Cb<DynamicGlobalProperties>): void;
    broadcastTransactionSynchronous(trx: VizTransaction, cb: Cb<BroadcastResult>): void;
  }

  interface VizConfig {
    set(key: string, value: string): void;
    get(key: string): unknown;
  }

  interface VizAuth {
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
