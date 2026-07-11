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

  /**
   * An annotated signed transaction as returned by get_transaction
   * (operation_history API). Operations + block_num are at the TOP level
   * (verified live against node.viz.cx 2026-06-28).
   */
  export interface AnnotatedTransaction {
    operations: Array<[string, Record<string, unknown>]>;
    block_num: number;
    transaction_id: string;
    transaction_num: number;
    ref_block_num: number;
    ref_block_prefix: number;
    expiration: string;
    signatures?: string[];
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

  export interface Authority {
    weight_threshold: number;
    account_auths: [string, number][];
    key_auths: [string, number][];
  }

  export interface Account {
    name: string;
    balance: string; // e.g. "189.027 VIZ"
    /** The multisig authority that must sign transfers (the peg-out release path). */
    active_authority: Authority;
  }

  interface VizApi {
    getDynamicGlobalProperties(cb: Cb<DynamicGlobalProperties>): void;
    getOpsInBlock(blockNum: number, onlyVirtual: boolean, cb: Cb<OpWrapper[]>): void;
    getTransaction(trxId: string, cb: Cb<AnnotatedTransaction | null>): void;
    getAccounts(names: string[], cb: Cb<Account[]>): void;
    /** Accepts a signed trx into the pending pool and returns WITHOUT waiting for block
     * inclusion. The public RPC proxy 504s on the synchronous variant's wait, so the
     * write path broadcasts async and confirms by exact id via a poll. */
    broadcastTransaction(trx: VizTransaction, cb: Cb<BroadcastResult>): void;
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

// Internal serializer + hash, used only to compute a transaction id deterministically
// (graphene: first 20 bytes of sha256 of the serialized UNSIGNED tx). viz-js-lib exposes
// no public txid helper; the dependency is git-pinned, so these paths are stable for this
// version. tools/idempotent-delivery-spike.cjs pins the computed id to guard against drift.
declare module "viz-js-lib/lib/auth/serializer/src/operations" {
  interface TxSerializer {
    toBuffer(tx: {
      ref_block_num: number;
      ref_block_prefix: number;
      expiration: string;
      operations: Array<[string, Record<string, unknown>]>;
      extensions: unknown[];
    }): Buffer;
  }
  export const transaction: TxSerializer;
}

declare module "viz-js-lib/lib/auth/ecc/src/hash" {
  export function sha256(data: Buffer): Buffer;
}

// secp256k1 public-key recovery, used to attribute each collected release signature to
// the VIZ key that produced it (so broadcastRelease attaches only signatures actually in
// the backing account's active authority). git-pinned; paths stable for this version.
declare module "viz-js-lib/lib/auth/ecc" {
  export class PublicKey {
    /** The address-prefixed public key string, e.g. "VIZ65QRp…" — matches key_auths. */
    toString(addressPrefix?: string): string;
  }
  export class Signature {
    static fromHex(hex: string): Signature;
    /** Recover the signing public key from the ORIGINAL buffer (hashes sha256 internally). */
    recoverPublicKeyFromBuffer(buffer: Buffer): PublicKey;
  }
}
