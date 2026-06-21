// Minimal ambient typings for the broadcast/api surface this setup utility uses.
declare module "viz-js-lib" {
  type Cb<T> = (err: unknown, res: T) => void;

  /** A VIZ authority: weighted accounts + keys with a weight threshold. */
  export interface Authority {
    weight_threshold: number;
    account_auths: Array<[string, number]>;
    key_auths: Array<[string, number]>;
  }

  export interface Account {
    name: string;
    memo_key: string;
    json_metadata: string;
    recovery_account: string;
    master_authority: Authority;
    active_authority: Authority;
    regular_authority: Authority;
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
  interface VizBroadcast {
    accountUpdateAsync(
      wif: string,
      account: string,
      master: Authority,
      active: Authority,
      regular: Authority,
      memoKey: string,
      jsonMetadata: string,
    ): Promise<unknown>;
    changeRecoveryAccountAsync(
      wif: string,
      accountToRecover: string,
      newRecoveryAccount: string,
      extensions: unknown[],
    ): Promise<unknown>;
  }

  interface VizAuth {
    signTransaction(trx: VizTransaction, keys: string[]): VizTransaction;
    wifToPublic(wif: string): string;
  }

  interface Viz {
    api: VizApi;
    config: VizConfig;
    broadcast: VizBroadcast;
    auth: VizAuth;
  }

  const viz: Viz;
  export default viz;
}
