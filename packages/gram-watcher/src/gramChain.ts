import { Address, JettonMaster, JettonWallet, TonClient, internal, SendMode, toNano } from "@ton/ton";
import { beginCell } from "@ton/core";
import type { Cell, Slice, Transaction } from "@ton/core";
import type { TransferRequest } from "@gateway/contracts-ton";
import type { RemoteBurn, RemoteChain, GramMintProposal } from "@gateway/common";
import { Multisig, Order } from "@gateway/contracts-ton";

/**
 * Live TON chain adapter — READ-ONLY (Phase B). It follows finalized burns,
 * reads jetton balances/supply, and reads multisig order state (existence,
 * executed, seqno) for the coordinator's keyless poll-until-executed broadcast.
 *
 * It holds NO key and never sends a message. The peg-in mint is authorized by
 * on-chain multisig-v2 approvals sent from each operator's OWN wallet in their
 * signer process (packages/gram-watcher/src/gramApprove.ts, driven by KeyedSigner).
 * This is what makes TON a genuine M-of-N: the coordinator that constructs the
 * order proposal cannot itself move funds. See docs/plan-ton-onchain-approval.md.
 *
 * Peg-out model: user sends wVIZ to the gateway's Jetton wallet with a text
 * comment = their VIZ account. The gateway jetton wallet RECEIVES a TEP-74
 * internal_transfer (0x178d4519) carrying amount, sender (from), and the
 * forward payload (comment) — NOT a transfer_notification, which a jetton wallet
 * emits to its owner. The watcher parses that (parseJettonDeposit) and enqueues
 * a VIZ release.
 *
 * Verified against toncenter: getMasterchainInfo().latestSeqno and
 * JettonMaster.getJettonData().totalSupply both read live; the inbound-message
 * parser is verified against real on-chain internal_transfer bodies and by a
 * constructed round-trip (tools/gram-notification-spike.cjs).
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Backoff base between failover attempts (500/1000/2000…ms); no sleep when there is only one endpoint. */
export const TON_RETRY_BASE_MS = 500;

/**
 * True for TON/toncenter transport failures that failing over to another endpoint can clear:
 * 5xx, 429 rate limits, socket resets/timeouts (incl. axios "timeout of Xms exceeded"), DNS
 * blips, "socket hang up" / "network error". This is the class that latched recon on
 * 2026-07-27 (toncenter ETIMEDOUT). Deliberately does NOT match a contract-level result
 * (an "exit_code" / "unable to execute get method" is a genuine chain state), so a real
 * not-found / executed read stays fast and fail-closed rather than churning the ring.
 *
 * ONE exit code is excepted: -13 is TVM out-of-gas, i.e. the NODE's get-method gas limit,
 * never an answer the contract chose to give. The read-only getters here (get_jetton_data,
 * get_wallet_data) cannot legitimately exhaust it, and on 2026-08-13 a sick toncenter node
 * returned it intermittently for the deployed minter + gateway wallet while a healthy Orbs
 * endpoint sat unused in the ring — because -13 was classified fail-closed, tonCall never
 * rotated, and 3 such ticks latched the "cannot verify backing" pause. Worst case if a -13
 * were ever genuine: one extra pass through the ring, then the same throw → indeterminate.
 *
 * The match runs over message + code + cause chain + AggregateError sub-errors, not the
 * message alone: 2026-08-20 the same pause latched again on two shapes whose messages carry
 * no keyword — axios "Client network socket disconnected before secure TLS connection was
 * established" (the ECONNRESET lives in err.code/err.cause.code) and AxiosError
 * [AggregateError] (empty message; the ECONNREFUSED/ETIMEDOUT codes live in err.errors[]).
 */
export function isTransientTonError(err: unknown): boolean {
  return /\b(429|50[0234])\b|exit_code:\s*-13\b|too many requests|bad gateway|service unavailable|gateway time-?out|time-?d?\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|disconnected before secure TLS/i.test(
    errorHaystack(err, 4),
  );
}

/** Flatten message + code + cause chain + AggregateError sub-errors into one searchable string. */
function errorHaystack(err: unknown, depth: number): string {
  if (err == null || depth < 0) return "";
  if (typeof err !== "object") return String(err);
  const e = err as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
  const parts = [String(e.message ?? ""), typeof e.code === "string" ? e.code : ""];
  if (Array.isArray(e.errors)) for (const sub of e.errors) parts.push(errorHaystack(sub, depth - 1));
  if (e.cause !== undefined) parts.push(errorHaystack(e.cause, depth - 1));
  return parts.join(" ");
}

/**
 * Build one TonClient per endpoint for read-path failover. The GRAM_API_KEY is a toncenter
 * credential, so apply it ONLY to toncenter-host endpoints; an Orbs / self-hosted liteserver
 * entry gets no key (it would reject or ignore it). Every client shares the same per-call
 * timeout. A single endpoint yields a single client — behaviour is unchanged from today.
 */
export function buildTonClients(endpoints: string[], apiKey: string, timeout: number): TonClient[] {
  const list = endpoints.map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("GramHttpChain: at least one GRAM endpoint is required");
  return list.map((endpoint) => {
    const key = apiKey && /toncenter/i.test(endpoint) ? apiKey : undefined;
    return new TonClient({ endpoint, apiKey: key, timeout });
  });
}

// TEP-74 op codes. A jetton wallet RECEIVES internal_transfer (from the sender's
// wallet) and EMITS transfer_notification (to its own owner). So the gateway's OWN
// jetton wallet sees internal_transfer as its inbound message; transfer_notification
// only appears when watching the owner address.
const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
// Standard governed-minter op codes (ton-blockchain/token-contract).
const OP_MINT = 21;
const OP_INTERNAL_TRANSFER = 0x178d4519;
// Standard TEP-74 jetton transfer (sender's wallet -> receiver). Used to move HELD wVIZ
// back OUT of the gateway's jetton wallet on an auto-return (op != the mint's internal_transfer).
const OP_JETTON_TRANSFER = 0x0f8a7ea5;

/**
 * Parse an inbound jetton message at the gateway's OWN jetton wallet into
 * {amount, sender, comment}. Accepts BOTH:
 *  - internal_transfer (0x178d4519): what the watched jetton wallet actually receives
 *    for every inbound transfer (even with zero forward_ton_amount). Layout adds
 *    response_address + forward_ton_amount before the forward_payload.
 *  - transfer_notification (0x7362d09c): what a jetton wallet emits to its owner —
 *    only seen if the watcher points at the owner address instead of the jetton wallet.
 * `sender` is the notification `sender` / internal_transfer `from`; `comment` is the
 * text forward_payload (the VIZ recipient). Returns null for any other op.
 */
export function parseJettonDeposit(
  body: Slice,
): { amountBaseUnits: bigint; sender: string; comment: string } | null {
  if (body.remainingBits < 32) return null;
  const op = body.loadUint(32);
  if (op !== OP_TRANSFER_NOTIFICATION && op !== OP_INTERNAL_TRANSFER) return null;
  body.loadUintBig(64); // query_id
  const amountBaseUnits = body.loadCoins();
  const sender = body.loadAddress().toString(); // notification: sender; internal_transfer: from
  if (op === OP_INTERNAL_TRANSFER) {
    body.loadMaybeAddress(); // response_address (may be addr_none)
    body.loadCoins(); // forward_ton_amount
  }
  // forward_payload: Either inline (bit 0) or in a ref (bit 1).
  const fp: Slice = body.loadBit() ? body.loadRef().beginParse() : body;
  let comment = "";
  if (fp.remainingBits >= 32) {
    const tag = fp.loadUint(32);
    if (tag === 0) comment = fp.loadStringTail(); // text comment
  }
  return { amountBaseUnits, sender, comment };
}

/**
 * Did this transaction's compute phase COMMIT? For a message received by the gateway's jetton
 * wallet, a committed compute phase means the standard TEP-74 wallet accepted the inbound
 * internal_transfer — which it only does after verifying on-chain that the sender is the genuine
 * peer jetton wallet of this minter for the declared `from` owner. So `true` here authenticates
 * the transfer's amount AND sender; a forged or rejected message aborts (`success: false` /
 * skipped / non-generic) and must never be parsed as a burn.
 */
export function txComputeSucceeded(tx: Pick<Transaction, "description">): boolean {
  const d = tx.description;
  return d?.type === "generic" && d.computePhase.type === "vm" && d.computePhase.success;
}

/**
 * The mint action an operator's multisig executes for a PEG_IN: a standard
 * governed-minter mint (OP=21) whose master_msg is the TEP-74 internal_transfer
 * that credits the recipient. PURE function of (minter, recipient, base-unit
 * amount) so every operator rebuilds the byte-identical order and can verify the
 * order hash the proposer shares. This is the single source of truth for both the
 * live write path (submitMint) and the sandbox proof
 * (tools/gram-onchain-approval-spike.cjs) — they MUST NOT drift.
 */
export function buildMintTransfer(
  minter: Address,
  toAddr: Address,
  amountBaseUnits: bigint,
): TransferRequest {
  const masterMsg = beginCell()
    .storeUint(OP_INTERNAL_TRANSFER, 32)
    .storeUint(0n, 64) // query_id
    .storeCoins(amountBaseUnits) // jetton amount (base units = milli-VIZ)
    .storeAddress(minter) // from = minter
    .storeAddress(toAddr) // response_destination
    .storeCoins(0n) // forward_ton_amount
    .storeBit(false) // no forward payload
    .endCell();
  const mintBody = beginCell()
    .storeUint(OP_MINT, 32)
    .storeUint(0n, 64) // query_id
    .storeAddress(toAddr) // to_address
    .storeCoins(toNano("0.05")) // ton_amount forwarded with the mint for wallet creation/fees
    .storeRef(masterMsg)
    .endCell();
  return {
    type: "transfer",
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    // value must cover the minter's compute gas (~5-10k units ≪ this) and let it
    // forward the 0.05 above; the minter has no excess-return on the mint op, so
    // anything beyond (0.05 + forward fee + gas) is stranded on the minter forever.
    // 0.06 leaves ~0.01 headroom (>10x a realistic fee spike) while nearly zeroing
    // that accumulation. It is SAFE against fee increases: with PAY_GAS_SEPARATELY
    // the minter pays forward fees from its own balance, so a shortfall draws from
    // its reserve rather than stranding the mint. The delivery-critical amount
    // (0.05 for the recipient's wallet deploy) is unchanged.
    message: internal({ to: minter, value: toNano("0.06"), body: mintBody }),
  };
}

/**
 * The packed multisig-v2 order cell for a mint + its 32-byte hash. The hash is the
 * value operators independently recompute and compare before approving (Phase B:
 * docs/plan-ton-onchain-approval.md).
 */
export function mintOrderCell(
  minter: Address,
  toAddr: Address,
  amountBaseUnits: bigint,
): { cell: Cell; hashHex: string } {
  const cell = Multisig.packOrder([buildMintTransfer(minter, toAddr, amountBaseUnits)]);
  return { cell, hashHex: cell.hash().toString("hex") };
}

/**
 * The multisig transfer request that RETURNS held wVIZ to the original peg-out sender: a
 * TEP-74 `transfer` (0x0f8a7ea5) sent to the gateway's OWN jetton wallet (owned by the
 * multisig), which forwards the jetton to `toAddr`, deploying the recipient's wallet via the
 * 0.05 forward. PURE function of (gatewayJettonWallet, toAddr, base-unit amount) so every
 * operator rebuilds the byte-identical order and verifies the hash before approving. Mirrors
 * buildMintTransfer, but transfers EXISTING supply instead of minting — supply-neutral.
 */
export function buildReturnTransfer(
  gatewayJettonWallet: Address,
  toAddr: Address,
  amountBaseUnits: bigint,
): TransferRequest {
  const transferBody = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(0n, 64) // query_id
    .storeCoins(amountBaseUnits) // wVIZ base units (= milli-VIZ)
    .storeAddress(toAddr) // destination = original sender
    .storeAddress(toAddr) // response_destination = sender (excess TON refunded to them)
    .storeMaybeRef(null) // custom_payload
    .storeCoins(toNano("0.05")) // forward_ton_amount: deploys the recipient's jetton wallet if absent
    .storeBit(false) // forward_payload: inline, empty
    .endCell();
  return {
    type: "transfer",
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    // Value the multisig sends WITH the transfer to the gateway jetton wallet: covers the
    // wallet's send gas + the 0.05 forward + headroom. PAY_GAS_SEPARATELY draws any shortfall
    // from the gateway wallet's balance so a fee spike never strands the return. Tune vs the
    // sandbox spike (Task 10) — the delivery-critical 0.05 forward is unchanged.
    message: internal({ to: gatewayJettonWallet, value: toNano("0.1"), body: transferBody }),
  };
}

/** Packed multisig-v2 order cell for a wVIZ return + its 32-byte hash (operators recompute+compare). */
export function returnOrderCell(
  gatewayJettonWallet: Address,
  toAddr: Address,
  amountBaseUnits: bigint,
): { cell: Cell; hashHex: string } {
  const cell = Multisig.packOrder([buildReturnTransfer(gatewayJettonWallet, toAddr, amountBaseUnits)]);
  return { cell, hashHex: cell.hash().toString("hex") };
}

/**
 * The cold-start scan cursor for a wallet whose newest tx is at `tipLt`. The scan
 * collects burns with `lt > cursor` (see paginateBurnsByLt), so the cursor must sit
 * JUST BELOW the tip — NOT at it. Anchoring AT `tipLt` would exclude the tip tx
 * itself, and when the wallet's first-ever transaction is an unprocessed peg-out
 * deposit (that deposit IS the tip at the moment we cold-start), it would be skipped
 * forever — the cursor only ever moves forward. `tipLt - 1` keeps the tip in range
 * and can never collide with a real lt (no tx has that value), so at most the single
 * tip tx is (idempotently, by tx-hash action id) re-examined. An empty wallet
 * (`tipLt === 0`) stays at 0 and re-cold-starts on the next tick.
 */
export function coldStartAnchorLt(tipLt: number): number {
  return tipLt > 0 ? tipLt - 1 : 0;
}

/**
 * Pure lt-pagination core for the peg-out scan (VG-06), factored out so it can be
 * exercised offline against a fake tx source (tools/gram-scan-pagination-spike.cjs).
 * Walks pages newest→older, skipping the repeated anchor tx, until it drains back
 * to `fromLt` / history end (`drained:true`) or exhausts `maxScanPages`
 * (`drained:false`). Only FINAL txs (`now <= cutoff`) count toward `newestFinalLt`
 * and are parsed as burns; the fresher tail is left for a later tick.
 */
export async function paginateBurnsByLt(params: {
  fromLt: bigint;
  cutoff: number;
  height: number;
  limit: number;
  maxScanPages: number;
  fetchPage: (anchor: { lt: string; hash: string } | null) => Promise<Transaction[]>;
  toBurn: (tx: Transaction, height: number) => RemoteBurn | null;
}): Promise<{ burns: RemoteBurn[]; newestFinalLt: bigint; drained: boolean }> {
  const { fromLt, cutoff, height, limit, maxScanPages, fetchPage, toBurn } = params;
  const burns: RemoteBurn[] = [];
  let newestFinalLt = fromLt;
  let anchor: { lt: string; hash: string } | null = null;
  let drained = false;
  let pages = 0;

  while (pages < maxScanPages && !drained) {
    const page = await fetchPage(anchor);
    pages++;
    if (page.length === 0) {
      drained = true; // no history at/under the anchor
      break;
    }
    const anchorLt = anchor ? BigInt(anchor.lt) : null;
    let sawFresh = false;
    for (const tx of page) {
      if (anchorLt !== null && tx.lt >= anchorLt) continue; // repeated anchor tx
      if (tx.lt <= fromLt) {
        drained = true; // reached the cursor: fully caught up
        break;
      }
      sawFresh = true;
      if (tx.now <= cutoff) {
        // Final => processed. The not-yet-final tail (higher lt) is intentionally
        // excluded so the cursor never advances past a tx we haven't finalized.
        if (tx.lt > newestFinalLt) newestFinalLt = tx.lt;
        const burn = toBurn(tx, height);
        if (burn) burns.push(burn);
      }
    }
    if (drained) break;
    // A short page (fewer than a full limit of txs) means we hit the end of history.
    const last = page[page.length - 1];
    if (!sawFresh || page.length < limit || !last) {
      drained = true;
      break;
    }
    anchor = { lt: last.lt.toString(), hash: last.hash().toString("hex") };
  }

  return { burns, newestFinalLt, drained };
}

export class GramHttpChain implements RemoteChain<GramMintProposal> {
  /**
   * One TonClient per endpoint and the sticky index of the one currently in use. Reads go
   * through tonCall(), which rotates to the next client on a TRANSIENT error so a single
   * toncenter outage can't latch recon (2026-07-27). A single endpoint = a single client =
   * exactly today's behaviour (one attempt, no rotation).
   */
  private readonly clients: TonClient[];
  private idx = 0;
  private get client(): TonClient {
    return this.clients[this.idx]!;
  }
  private readonly minter: Address;
  private readonly gatewayWallet: Address | null;
  private readonly multisigAddress: string;
  private readonly finalityBufferSec: number;
  private readonly maxTransactions: number;
  private readonly maxScanPages: number;

  constructor(
    endpoints: string | string[],
    apiKey: string,
    minterAddress: string,
    gatewayJettonWallet: string,
    multisigAddress: string,
    finalityConfirmations: number,
    maxTransactions = 20,
    maxScanPages = 50,
    // Per-call toncenter deadline. 30s (not 10s): the transaction-index endpoint is slow
    // and rate-limited under a live run's own load, and a too-tight ceiling makes
    // cold-start's newestLt() time out / read empty until the burn has already landed,
    // after which the strictly-newer forward scan skips it. See config.ts gram.rpcTimeoutMs.
    rpcTimeoutMs = 30_000,
  ) {
    this.clients = buildTonClients(Array.isArray(endpoints) ? endpoints : [endpoints], apiKey, rpcTimeoutMs);
    this.minter = Address.parse(minterAddress);
    this.gatewayWallet = gatewayJettonWallet ? Address.parse(gatewayJettonWallet) : null;
    this.multisigAddress = multisigAddress;
    // ~5s per masterchain block; convert the confirmation count to a time buffer.
    this.finalityBufferSec = Math.max(6, finalityConfirmations * 5 + 5);
    this.maxTransactions = Math.max(1, maxTransactions);
    this.maxScanPages = Math.max(1, maxScanPages);
  }

  /**
   * Run a read against the current endpoint; on a TRANSIENT error rotate to the next client
   * (sticky idx) and retry, one pass through the ring (attempts = endpoint count). A single
   * endpoint means one attempt with no rotation — identical to the pre-failover behaviour, so
   * the outer watcher/recon loop still owns the tick-level retry. Non-transient errors (a real
   * contract read result, a bad address) throw immediately without rotating (fail-closed). The
   * whole read runs inside fn(), so a multi-page scan re-runs from the top on a rotated client —
   * safe because every read here is idempotent.
   */
  private async tonCall<T>(fn: () => Promise<T>): Promise<T> {
    const attempts = this.clients.length;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === attempts || !isTransientTonError(err)) throw err;
        this.idx = (this.idx + 1) % this.clients.length;
        await sleep(TON_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr; // unreachable
  }

  async finalizedHeight(): Promise<number> {
    return this.tonCall(async () => (await this.client.getMasterchainInfo()).latestSeqno);
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    return this.tonCall(async () => {
      const master = this.client.open(JettonMaster.create(this.minter));
      const data = await master.getJettonData();
      // Subtract wVIZ held INERT in the gateway's OWN jetton wallet. A peg-out TRANSFERS
      // wVIZ into the gateway wallet (it is not burned), so that balance is non-circulating
      // reserve — counting it as circulating makes recon see phantom under-backing (mirrors
      // the site display fix 497f835: circulating = totalSupply − gatewayHeld).
      if (this.gatewayWallet) {
        let held: bigint;
        try {
          const wallet = this.client.open(JettonWallet.create(this.gatewayWallet));
          held = await wallet.getBalance();
        } catch (err) {
          // A TRANSIENT held read (toncenter 5xx/timeout/reset) must NOT silently fall back
          // to raw totalSupply: when the gateway holds a non-trivial wVIZ reserve (a peg-out
          // pending burn), that fallback OVER-counts circulating by the full held balance and
          // trips a FALSE under-backing pause (2026-08-04: held=3960 VIZ → phantom −3912.5).
          // Re-throw so tonCall rotates to another endpoint; if every endpoint is down the
          // error propagates to recon, which treats an unavailable supply as INDETERMINATE
          // (consecutive-failure counter, pauses only after N) rather than a shortfall —
          // mirrors the empty-backing-read fix (PR #111).
          if (isTransientTonError(err)) throw err;
          // A NON-transient get-method failure is NOT proof the wallet is uninitialized:
          // 2026-08-12 a sick node returned "exit_code: -13" for the DEPLOYED, funded gateway
          // wallet (and the minter), and the held=0 guess re-created the same false pause.
          // Only a positive state read may authorize the held=0 fallback; an ACTIVE wallet
          // means the failure is the node's, so re-throw → recon INDETERMINATE.
          const state = await this.client.getContractState(this.gatewayWallet);
          if (state.state === "active") throw err;
          // The state read itself needs a second opinion (same rationale as confirmZeroHeld):
          // 2026-08-15 a sick node answered "uninitialized" for the DEPLOYED, funded gateway
          // wallet, "positively" authorizing the held=0 fallback and re-creating the false
          // −3912500 pause. Any other endpoint seeing the wallet active means the failure is
          // the node's ⇒ re-throw → recon INDETERMINATE.
          for (let i = 1; i < this.clients.length; i++) {
            const other = this.clients[(this.idx + i) % this.clients.length]!;
            const second = await other.getContractState(this.gatewayWallet);
            if (second.state === "active") throw err;
          }
          console.warn(`[gram] gateway jetton wallet ${state.state} ⇒ held=0: ${String(err)}`);
          return data.totalSupply;
        }
        // OUTSIDE the try: confirmZeroHeld's disagreement throw must reach recon as
        // INDETERMINATE. Inside it, the catch above re-interpreted the refusal as
        // "uninitialized ⇒ held=0" — the exact reading it refused (2026-08-15 pause).
        if (held === 0n) await this.confirmZeroHeld();
        const circulating = data.totalSupply - held;
        return circulating > 0n ? circulating : 0n;
      }
      return data.totalSupply; // 3-decimal jetton => base units are milli-VIZ
    });
  }

  /**
   * Cross-check a held balance of ZERO against the other endpoints in the ring.
   *
   * A jetton wallet may legitimately hold 0 (wallets stay deployed after being emptied), so a
   * zero is not an error and must not be rejected outright. But a sick node also returns a
   * SUCCESSFUL 0 for a funded wallet, and that answer is the worst possible one: it is
   * definitive, so it resets recon's consecutive-failure counter and over-counts circulating by
   * the entire gateway reserve, pausing immediately. 2026-08-13: three false −3912500 mVIZ
   * under-backing pauses, with no exception thrown and no "held=0" warning logged — the zero
   * arrived through the SUCCESS path, which PR #124 (the throw path) never covered.
   *
   * A wrong zero is one node's opinion, so ask the others: any non-zero second opinion means the
   * zero was the node's, and throwing hands recon an INDETERMINATE (retried next tick) instead of
   * a phantom shortfall. Only reached when held is 0, so the extra reads cost nothing in the
   * normal case. One endpoint = nobody to ask = today's behaviour.
   */
  private async confirmZeroHeld(): Promise<void> {
    if (!this.gatewayWallet) return;
    for (let i = 1; i < this.clients.length; i++) {
      const other = this.clients[(this.idx + i) % this.clients.length]!;
      const second = await other.open(JettonWallet.create(this.gatewayWallet)).getBalance();
      if (second !== 0n) {
        throw new Error(
          `held-balance disagreement for ${this.gatewayWallet.toString()}: endpoint[${this.idx}] read 0, ` +
            `another endpoint read ${second} — refusing to treat the zero as a real reserve drop`,
        );
      }
    }
  }

  /** Is the recipient's jetton-wallet already deployed? (else minting deploys it, costing gas). */
  async isDestinationProvisioned(recipient: string): Promise<boolean> {
    return this.tonCall(async () => {
      const master = this.client.open(JettonMaster.create(this.minter));
      const jettonWallet = await master.getWalletAddress(Address.parse(recipient));
      const state = await this.client.getContractState(jettonWallet);
      return state.state === "active";
    });
  }

  /**
   * Parse one gateway-wallet tx into a RemoteBurn, or null if it is not a final
   * transfer_notification. Shared by the watcher's forward scan (finalizedBurnsSince)
   * and the signer's independent re-read (getBurn) so both apply the SAME finality
   * cutoff and parse — the signer never validates a burn the watcher wouldn't treat as
   * final.
   */
  private burnFromTx(tx: Transaction, cutoff: number, height: number): RemoteBurn | null {
    if (tx.now > cutoff) return null; // not yet final per the time buffer
    // Trust the jetton wallet's OWN on-chain check, not the message body. A real inbound wVIZ
    // transfer only CREDITS the gateway wallet if its compute phase commits: the standard TEP-74
    // wallet throws unless the internal_transfer arrives from the genuine peer jetton wallet of
    // this minter. A hand-crafted internal_transfer / transfer_notification from any other address
    // ABORTS in compute — yet the tx still lands on the account and is returned by getTransactions.
    // Parsing amount/sender/comment out of such a rejected message (moving zero wVIZ) would let
    // anyone forge a peg-out and drain the VIZ backing (both the release and the auto-return path
    // inherit this guard, since getBurn re-reads through here too).
    if (!txComputeSucceeded(tx)) return null;
    const inMsg = tx.inMessage;
    if (!inMsg || inMsg.body.bits.length === 0) return null;
    const parsed = parseJettonDeposit(inMsg.body.beginParse());
    if (!parsed) return null;
    return {
      chain: "GRAM",
      sourceId: tx.hash().toString("hex"),
      height,
      from: parsed.sender,
      amountMilliViz: parsed.amountBaseUnits,
      homeDestination: parsed.comment.trim(),
    };
  }

  /**
   * The newest tx's logical time on the gateway wallet, or 0 if it has no history.
   * Used for the watcher's cold start: begin at the current tip's `lt` so we don't
   * replay all history (backfill before first-ever run is a separate operation).
   *
   * Empty-vs-error: a transport failure THROWS (propagates to the watcher loop's
   * try/catch, which leaves the cursor at 0 and retries next tick — never a false
   * anchor). Only a genuinely empty response (no history) returns 0, which is correct
   * to re-cold-start on. The real hazard is a rate-limited empty read on a wallet that
   * DOES have history anchoring the cursor late; the wider rpcTimeoutMs (30s) is what
   * keeps this read reliable under a live run's toncenter load so cold-start locks the
   * pre-burn tip on the first tick.
   */
  async newestLt(): Promise<number> {
    if (!this.gatewayWallet) return 0;
    const wallet = this.gatewayWallet;
    return this.tonCall(async () => {
      const txs = await this.client.getTransactions(wallet, { limit: 1 });
      const tip = txs[0];
      return tip ? Number(tip.lt) : 0;
    });
  }

  /**
   * Range-based peg-out scan keyed on logical time (`lt`) — the correct cursor for
   * an account's own tx stream (VG-06). Pages the gateway wallet's transactions
   * newest→older via getTransactions' {lt, hash} anchor, collecting final burns with
   * `lt > fromLt`, until it either drains back to the cursor / history end
   * (`drained: true`) or hits `maxScanPages` with more to scan (`drained: false` —
   * a burst we cannot fully see this tick; the caller MUST fail closed and not
   * advance the cursor past the unscanned older burns).
   *
   * `newestFinalLt` is the highest lt among FINAL txs seen (the cursor's next value
   * after a complete drain). The not-yet-final tail (higher lt) is left for a later
   * tick and never advances the cursor past it, so no burn is skipped.
   */
  async finalizedBurnsPaginated(
    fromLt: number,
  ): Promise<{ burns: RemoteBurn[]; newestFinalLt: number; drained: boolean }> {
    if (!this.gatewayWallet) return { burns: [], newestFinalLt: fromLt, drained: true };
    const wallet = this.gatewayWallet;
    return this.tonCall(async () => {
      const cutoff = Math.floor(Date.now() / 1000) - this.finalityBufferSec;
      const height = (await this.client.getMasterchainInfo()).latestSeqno;
      const res = await paginateBurnsByLt({
        fromLt: BigInt(fromLt),
        cutoff,
        height,
        limit: this.maxTransactions,
        maxScanPages: this.maxScanPages,
        // Pin to THIS attempt's client so a whole page walk uses one endpoint; a transient
        // failure mid-walk rejects out to tonCall, which rotates and re-runs the walk from
        // fromLt (idempotent).
        fetchPage: (anchor) =>
          this.client.getTransactions(
            wallet,
            anchor
              ? { limit: this.maxTransactions, lt: anchor.lt, hash: anchor.hash, inclusive: true }
              : { limit: this.maxTransactions },
          ),
        toBurn: (tx, h) => this.burnFromTx(tx, cutoff, h),
      });
      return { burns: res.burns, newestFinalLt: Number(res.newestFinalLt), drained: res.drained };
    });
  }

  /**
   * Interface conformance (RemoteChain). The TON watcher drives the lt-ranged
   * finalizedBurnsPaginated directly (for its truncation signal); this thin wrapper
   * treats `fromHeight` as the lt cursor and returns just the burns.
   */
  async finalizedBurnsSince(fromLt: number, _toHeight: number): Promise<RemoteBurn[]> {
    return (await this.finalizedBurnsPaginated(fromLt)).burns;
  }

  /**
   * F2 independent re-read: given a burn tx hash (the peg-out action.id), re-derive the
   * RemoteBurn from the operator's OWN node. The sourceId alone lacks lt/address for a
   * direct fetch, so we bounded-scan the gateway wallet's own recent transactions — the
   * same view finalizedBurnsSince uses — and match by tx hash. A compromised coordinator
   * cannot forge this: the burn, comment (VIZ recipient), and amount all come from chain.
   *
   * Returns null (→ fail-closed stall at the signer) when the tx is not in the scan
   * window, is not a transfer_notification, or is not yet final. Bound: only the last
   * `maxTransactions` gateway txs are visible — a release delayed past that window cannot
   * be validated until the limit is raised or the scan paginated.
   */
  async getBurn(sourceId: string): Promise<RemoteBurn | null> {
    if (!this.gatewayWallet) return null;
    const wallet = this.gatewayWallet;
    return this.tonCall(async () => {
      const cutoff = Math.floor(Date.now() / 1000) - this.finalityBufferSec;
      const txs = await this.client.getTransactions(wallet, { limit: this.maxTransactions });
      for (const tx of txs) {
        if (tx.hash().toString("hex") !== sourceId) continue;
        const height = (await this.client.getMasterchainInfo()).latestSeqno;
        return this.burnFromTx(tx, cutoff, height);
      }
      return null;
    });
  }

  /**
   * Deterministic order address for the NEXT order this signer would create.
   *
   * TON multisig order addresses are a pure function of (multisig, orderSeqno),
   * and `nextOrderSeqno` only advances when an order is actually created. So the
   * next order address is a durable idempotency key we can persist BEFORE sending
   * `sendNewOrder`: on crash recovery `orderExists()` tells us whether that exact
   * order already landed, so we never propose a second (double-mint) order.
   */
  async nextOrderAddress(): Promise<{ orderAddr: string; seqno: string }> {
    if (!this.multisigAddress) throw new Error("GRAM_MULTISIG_ADDRESS is required for nextOrderAddress");
    return this.tonCall(async () => {
      const dataMultisig = this.client.open(Multisig.createFromAddress(Address.parse(this.multisigAddress)));
      const data = await dataMultisig.getMultisigData();
      const orderAddr = await dataMultisig.getOrderAddress(data.nextOrderSeqno);
      return { orderAddr: orderAddr.toString(), seqno: data.nextOrderSeqno.toString() };
    });
  }

  /**
   * True if a multisig order at `orderAddr` is deployed on-chain (i.e. a new_order
   * landed). This is the stronger, correct idempotency predicate: the order contract
   * persists after it executes (its `executed` flag stays readable via get_order_data),
   * so existence — not the executed flag — is what we must not duplicate. An order that
   * exists but has not executed yet is still a commitment; re-broadcasting would create
   * a SECOND order.
   */
  async orderExists(orderAddr: string): Promise<boolean> {
    return this.tonCall(async () => {
      const state = await this.client.getContractState(Address.parse(orderAddr));
      return state.state === "active";
    });
  }

  /**
   * The packed mint-order cell hash operators independently rebuild + compare
   * before approving. Seqno-INDEPENDENT (depends only on minter + recipient + net),
   * so the coordinator can pin it in the proposal and every operator recomputes the
   * exact same value from the canonical action. This binds each on-chain approval to
   * the recipient/amount the operator validated. Uses THIS chain's pinned minter.
   */
  orderHashFor(toAddress: string, amountBaseUnits: bigint): string {
    return mintOrderCell(this.minter, Address.parse(toAddress), amountBaseUnits).hashHex;
  }

  /** Seqno-independent order hash for a wVIZ RETURN transfer (operators verify before approving). */
  returnOrderHashFor(toAddress: string, amountBaseUnits: bigint): string {
    if (!this.gatewayWallet) throw new Error("GRAM_GATEWAY_JETTON_WALLET is required for returnOrderHashFor");
    return returnOrderCell(this.gatewayWallet, Address.parse(toAddress), amountBaseUnits).hashHex;
  }

  /**
   * Read a multisig order's state: whether it is inited (a new_order landed),
   * executed (threshold reached → the mint fired), and its approval count. Returns
   * `{ inited:false }` if the order contract is not deployed yet. This is the read
   * the coordinator's keyless broadcast polls to confirm the mint executed, and the
   * operator-side approver uses to decide propose-vs-approve.
   */
  async orderData(
    orderAddr: string,
  ): Promise<{ inited: boolean; executed: boolean; approvalsNum: number; threshold: number }> {
    const addr = Address.parse(orderAddr);
    return this.tonCall(async () => {
      const state = await this.client.getContractState(addr);
      if (state.state !== "active") return { inited: false, executed: false, approvalsNum: 0, threshold: 0 };
      const od = await this.client.open(Order.createFromAddress(addr)).getOrderData();
      return {
        inited: Boolean(od.inited),
        executed: Boolean(od.executed),
        approvalsNum: Number(od.approvals_num ?? 0),
        threshold: Number(od.threshold ?? 0),
      };
    });
  }

  /**
   * True once the order at `orderAddr` has EXECUTED (threshold approvals reached and
   * the mint fired). This — not mere existence — is the coordinator's "mint landed"
   * predicate: an order that exists but is under threshold must keep collecting
   * approvals, not be treated as done. (Existence is the *no-second-order* guard,
   * enforced by the operator-side proposer via orderExists.)
   */
  async orderExecuted(orderAddr: string): Promise<boolean> {
    return (await this.orderData(orderAddr)).executed;
  }

  /** Native TON balance of an address, in nano-TON. Used by the recon reserve monitor. */
  async tonBalanceNano(address: string): Promise<bigint> {
    return this.tonCall(async () => this.client.getBalance(Address.parse(address)));
  }

  /**
   * RETIRED (Phase B): the coordinator is keyless on TON and never sends a message.
   * The mint is authorized by on-chain multisig approvals from each operator's own
   * wallet (KeyedSigner.approveGramMint → tonApprove.ts). Kept only to satisfy the
   * RemoteChain interface; calling it is a wiring bug (a would-be keyed coordinator).
   */
  async submitMint(_proposal: GramMintProposal, _mintAuth: string[]): Promise<string> {
    throw new Error(
      "GramHttpChain.submitMint is retired: TON mints are authorized by on-chain operator approvals " +
        "(GramMintBroadcaster polls orderExecuted; operators propose/approve from their own wallets).",
    );
  }
}
