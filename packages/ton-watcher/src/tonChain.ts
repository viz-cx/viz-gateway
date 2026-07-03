import { Address, JettonMaster, TonClient, internal, SendMode, toNano } from "@ton/ton";
import { beginCell } from "@ton/core";
import type { Cell, Slice, Transaction } from "@ton/core";
import type { TransferRequest } from "@gateway/contracts-ton";
import type { RemoteBurn, RemoteChain, TonMintProposal } from "@gateway/common";
import { Multisig, Order } from "@gateway/contracts-ton";

/**
 * Live TON chain adapter — READ-ONLY (Phase B). It follows finalized burns,
 * reads jetton balances/supply, and reads multisig order state (existence,
 * executed, seqno) for the coordinator's keyless poll-until-executed broadcast.
 *
 * It holds NO key and never sends a message. The peg-in mint is authorized by
 * on-chain multisig-v2 approvals sent from each operator's OWN wallet in their
 * signer process (packages/ton-watcher/src/tonApprove.ts, driven by KeyedSigner).
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
 * constructed round-trip (tools/ton-notification-spike.cjs).
 */

// TEP-74 op codes. A jetton wallet RECEIVES internal_transfer (from the sender's
// wallet) and EMITS transfer_notification (to its own owner). So the gateway's OWN
// jetton wallet sees internal_transfer as its inbound message; transfer_notification
// only appears when watching the owner address.
const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
// Standard governed-minter op codes (ton-blockchain/token-contract).
const OP_MINT = 21;
const OP_INTERNAL_TRANSFER = 0x178d4519;

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
 * The mint action an operator's multisig executes for a PEG_IN: a standard
 * governed-minter mint (OP=21) whose master_msg is the TEP-74 internal_transfer
 * that credits the recipient. PURE function of (minter, recipient, base-unit
 * amount) so every operator rebuilds the byte-identical order and can verify the
 * order hash the proposer shares. This is the single source of truth for both the
 * live write path (submitMint) and the sandbox proof
 * (tools/ton-onchain-approval-spike.cjs) — they MUST NOT drift.
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
    message: internal({ to: minter, value: toNano("0.1"), body: mintBody }),
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

export class TonHttpChain implements RemoteChain<TonMintProposal> {
  private readonly client: TonClient;
  private readonly minter: Address;
  private readonly gatewayWallet: Address | null;
  private readonly multisigAddress: string;
  private readonly finalityBufferSec: number;
  private readonly maxTransactions: number;

  constructor(
    endpoint: string,
    apiKey: string,
    minterAddress: string,
    gatewayJettonWallet: string,
    multisigAddress: string,
    finalityConfirmations: number,
    maxTransactions = 20,
  ) {
    this.client = new TonClient({ endpoint, apiKey: apiKey || undefined, timeout: 10000 });
    this.minter = Address.parse(minterAddress);
    this.gatewayWallet = gatewayJettonWallet ? Address.parse(gatewayJettonWallet) : null;
    this.multisigAddress = multisigAddress;
    // ~5s per masterchain block; convert the confirmation count to a time buffer.
    this.finalityBufferSec = Math.max(6, finalityConfirmations * 5 + 5);
    this.maxTransactions = Math.max(1, maxTransactions);
  }

  async finalizedHeight(): Promise<number> {
    return (await this.client.getMasterchainInfo()).latestSeqno;
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    const master = this.client.open(JettonMaster.create(this.minter));
    const data = await master.getJettonData();
    return data.totalSupply; // 3-decimal jetton => base units are milli-VIZ
  }

  /** Is the recipient's jetton-wallet already deployed? (else minting deploys it, costing gas). */
  async isDestinationProvisioned(recipient: string): Promise<boolean> {
    const master = this.client.open(JettonMaster.create(this.minter));
    const jettonWallet = await master.getWalletAddress(Address.parse(recipient));
    const state = await this.client.getContractState(jettonWallet);
    return state.state === "active";
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
    const inMsg = tx.inMessage;
    if (!inMsg || inMsg.body.bits.length === 0) return null;
    const parsed = parseJettonDeposit(inMsg.body.beginParse());
    if (!parsed) return null;
    return {
      sourceId: tx.hash().toString("hex"),
      height,
      from: parsed.sender,
      amountMilliViz: parsed.amountBaseUnits,
      homeDestination: parsed.comment.trim(),
    };
  }

  async finalizedBurnsSince(_fromHeight: number, toHeight: number): Promise<RemoteBurn[]> {
    if (!this.gatewayWallet) return [];
    const cutoff = Math.floor(Date.now() / 1000) - this.finalityBufferSec;
    const txs = await this.client.getTransactions(this.gatewayWallet, { limit: this.maxTransactions });
    const burns: RemoteBurn[] = [];
    for (const tx of txs) {
      const burn = this.burnFromTx(tx, cutoff, toHeight);
      if (burn) burns.push(burn);
    }
    return burns;
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
    const cutoff = Math.floor(Date.now() / 1000) - this.finalityBufferSec;
    const txs = await this.client.getTransactions(this.gatewayWallet, { limit: this.maxTransactions });
    for (const tx of txs) {
      if (tx.hash().toString("hex") !== sourceId) continue;
      const height = (await this.client.getMasterchainInfo()).latestSeqno;
      return this.burnFromTx(tx, cutoff, height);
    }
    return null;
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
    if (!this.multisigAddress) throw new Error("TON_MULTISIG_ADDRESS is required for nextOrderAddress");
    const dataMultisig = this.client.open(Multisig.createFromAddress(Address.parse(this.multisigAddress)));
    const data = await dataMultisig.getMultisigData();
    const orderAddr = await dataMultisig.getOrderAddress(data.nextOrderSeqno);
    return { orderAddr: orderAddr.toString(), seqno: data.nextOrderSeqno.toString() };
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
    const state = await this.client.getContractState(Address.parse(orderAddr));
    return state.state === "active";
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
    const state = await this.client.getContractState(addr);
    if (state.state !== "active") return { inited: false, executed: false, approvalsNum: 0, threshold: 0 };
    const od = await this.client.open(Order.createFromAddress(addr)).getOrderData();
    return {
      inited: Boolean(od.inited),
      executed: Boolean(od.executed),
      approvalsNum: Number(od.approvals_num ?? 0),
      threshold: Number(od.threshold ?? 0),
    };
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

  /**
   * RETIRED (Phase B): the coordinator is keyless on TON and never sends a message.
   * The mint is authorized by on-chain multisig approvals from each operator's own
   * wallet (KeyedSigner.approveTonMint → tonApprove.ts). Kept only to satisfy the
   * RemoteChain interface; calling it is a wiring bug (a would-be keyed coordinator).
   */
  async submitMint(_proposal: TonMintProposal, _mintAuth: string[]): Promise<string> {
    throw new Error(
      "TonHttpChain.submitMint is retired: TON mints are authorized by on-chain operator approvals " +
        "(TonMintBroadcaster polls orderExecuted; operators propose/approve from their own wallets).",
    );
  }
}
