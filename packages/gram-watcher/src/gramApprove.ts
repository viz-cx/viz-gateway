import { Address, TonClient, WalletContractV4, WalletContractV5R1, toNano } from "@ton/ton";
import { Multisig, Order } from "@gateway/contracts-ton";
import type { TransferRequest } from "@gateway/contracts-ton";
import type { GramMintProposal } from "@gateway/common";
import { buildMintTransfer, mintOrderCell, buildReturnTransfer, returnOrderCell } from "./gramChain";
import { keyPairFromMnemonic } from "./gramSign";

/**
 * Operator-side TON multisig-v2 approval routing (Phase B write path).
 *
 * This is the ONLY component that sends a TON message, and it runs INSIDE the
 * operator's own signer process using the operator's own wallet key and own node.
 * The coordinator stays keyless: it only describes the order (GramMintProposal).
 *
 * multisig-v2 has no off-chain signature aggregation — an approval IS an on-chain
 * `Order.approve` from `signers[myIdx]`'s wallet. So:
 *   - the FIRST live operator contacted while the order is still absent opens it with
 *     `new_order` + approve_on_init (its own approval counts immediately); the order
 *     seqno is pinned in the proposal, so every operator targets the same deterministic
 *     order address. There is no single hardcoded proposer: whichever live operator is
 *     asked first opens the order, so a stuck/unfunded/offline operator no longer
 *     deadlocks the mint — the role fails over to the next operator the coordinator
 *     contacts (see docs/plan-ton-onchain-approval.md);
 *   - every other operator sees the order already exists and sends `approve`;
 *   - the order self-executes the moment approvals_num == threshold.
 *
 * Idempotency: the order address is f(multisig, seqno) and is pinned in the
 * proposal before anyone proposes. A proposer re-driven after a crash finds its
 * order already exists and does NOT create a second one; an approver re-driven
 * finds its bit already set and does NOT approve twice (the contract also rejects
 * a duplicate with err 107). Design: docs/plan-ton-onchain-approval.md.
 */

/** How the operator's on-chain effect resolved, encoded into the approval receipt. */
export type TonApprovalRole = "propose" | "approve" | "already" | "executed";

export interface GramApprovalReceipt {
  orderAddr: string;
  myIdx: number;
  role: TonApprovalRole;
}

/** Rebuild the return order cell and assert its hash matches the proposal (binds recipient+amount). */
export function assertReturnOrderHash(
  gatewayJettonWallet: Address,
  toAddr: Address,
  amountBaseUnits: bigint,
  expectedHex: string,
): void {
  const { hashHex } = returnOrderCell(gatewayJettonWallet, toAddr, amountBaseUnits);
  if (hashHex !== expectedHex) {
    throw new Error(`TON return order hash mismatch: rebuilt ${hashHex} != proposal ${expectedHex}`);
  }
}

/** The on-chain approval surface KeyedSigner depends on (injectable for tests). */
export interface GramApprovalClient {
  approveMint(proposal: GramMintProposal): Promise<GramApprovalReceipt>;
  approveReturn(proposal: GramMintProposal): Promise<GramApprovalReceipt>;
}

/** TTL for a new multisig order (1 hour covers any realistic signing latency). */
const ORDER_TTL_SEC = 3600;

/** Encode a receipt into the `Approval.signature` slot (the orchestrator only needs presence). */
export function encodeReceipt(r: GramApprovalReceipt): string {
  return `ton:${r.orderAddr}:${r.myIdx}:${r.role}`;
}

export interface GramApproverOpts {
  /** Poll interval while waiting for an order/approval to land on-chain (ms). */
  pollIntervalMs?: number;
  /** Max time to wait for the proposer's order to appear / an approval to reflect (ms). */
  maxWaitMs?: number;
  /** TON (nano) the proposer attaches to new_order to fund the Order contract. */
  orderValueNano?: bigint;
}

export class GramApprover implements GramApprovalClient {
  private readonly client: TonClient;
  private readonly minter: Address;
  private readonly multisigAddr: Address;
  private readonly gatewayJettonWallet: Address;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly orderValueNano: bigint;

  constructor(
    endpoint: string,
    apiKey: string,
    minterAddress: string,
    multisigAddress: string,
    private readonly mnemonic: string,
    gatewayJettonWallet: Address,
    opts: GramApproverOpts = {},
  ) {
    if (!minterAddress) throw new Error("GramApprover: minter address is required");
    if (!multisigAddress) throw new Error("GramApprover: GRAM_MULTISIG_ADDRESS is required");
    if (!mnemonic) throw new Error("GramApprover: GRAM_SIGNER_MNEMONIC is required to approve on-chain");
    this.client = new TonClient({ endpoint, apiKey: apiKey || undefined, timeout: 10000 });
    this.minter = Address.parse(minterAddress);
    this.multisigAddr = Address.parse(multisigAddress);
    this.gatewayJettonWallet = gatewayJettonWallet;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxWaitMs = opts.maxWaitMs ?? 60000;
    this.orderValueNano = opts.orderValueNano ?? toNano("1");
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async orderIsInited(orderAddr: Address): Promise<boolean> {
    return (await this.client.getContractState(orderAddr)).state === "active";
  }

  async approveMint(proposal: GramMintProposal): Promise<GramApprovalReceipt> {
    const toAddr = Address.parse(proposal.toAddress);
    const amountBaseUnits = BigInt(proposal.amountMilliViz);

    // Bind the on-chain effect to the recipient/amount this operator validated: rebuild
    // the exact mint-order cell and assert its hash matches the proposer's. A compromised
    // coordinator cannot make us propose/approve an order that mints anything else.
    const { hashHex } = mintOrderCell(this.minter, toAddr, amountBaseUnits);
    if (hashHex !== proposal.orderHashHex) {
      throw new Error(
        `TON order hash mismatch for ${proposal.actionId}: rebuilt ${hashHex} != proposal ${proposal.orderHashHex}`,
      );
    }

    const mintTransfer = buildMintTransfer(this.minter, toAddr, amountBaseUnits);
    return this.sendOrApprove(mintTransfer, proposal);
  }

  async approveReturn(proposal: GramMintProposal): Promise<GramApprovalReceipt> {
    const toAddr = Address.parse(proposal.toAddress);
    const amountBaseUnits = BigInt(proposal.amountMilliViz);
    assertReturnOrderHash(this.gatewayJettonWallet, toAddr, amountBaseUnits, proposal.orderHashHex);
    const returnTransfer = buildReturnTransfer(this.gatewayJettonWallet, toAddr, amountBaseUnits);
    return this.sendOrApprove(returnTransfer, proposal);
  }

  /** Shared open-or-wait + approve for any single-action multisig order (mint OR return). */
  private async sendOrApprove(transfer: TransferRequest, proposal: GramMintProposal): Promise<GramApprovalReceipt> {
    // Derive THIS operator's wallet + signer index from its own mnemonic. Operators
    // may run either a v4 or a v5r1 (W5) wallet, and the multisig stores only the
    // resolved address — so try both flavours and use whichever address is actually
    // in the on-chain signer set. Keeps a mixed-wallet-version federation working
    // (e.g. op-1 on W5, others on v4) without per-operator version config.
    const { publicKey, secretKey } = await keyPairFromMnemonic(this.mnemonic);
    const pk = Buffer.from(publicKey);
    const candidates = [
      WalletContractV4.create({ workchain: 0, publicKey: pk }),
      WalletContractV5R1.create({ workchain: 0, publicKey: pk }),
    ];
    const md = await this.client.open(Multisig.createFromAddress(this.multisigAddr)).getMultisigData();
    let wallet: WalletContractV4 | WalletContractV5R1 | undefined;
    let myIdx = -1;
    for (const cand of candidates) {
      const idx = md.signers.findIndex((s) => s.equals(cand.address));
      if (idx >= 0) {
        wallet = cand;
        myIdx = idx;
        break;
      }
    }
    if (!wallet || myIdx < 0) {
      throw new Error(
        `TON approve: operator wallet (v4 ${candidates[0]!.address.toString()} / ` +
          `v5r1 ${candidates[1]!.address.toString()}) is not in the multisig signer set`,
      );
    }

    const orderAddr = Address.parse(proposal.orderAddr);
    // Union type: open() typing is pinned to one flavour but runtime dispatch hits
    // the resolved instance; both expose the same sender()/send methods we use.
    const openedWallet = this.client.open(wallet as WalletContractV4);
    const sender = openedWallet.sender(Buffer.from(secretKey));

    // --- Open-or-wait (no single designated proposer; role fails over across operators) ---
    // Whichever live operator is contacted while the order is still absent opens it. The
    // coordinator contacts live operators sequentially and each opener blocks on
    // waitForOrderInited, so the order is confirmed present-or-absent before the next
    // operator is asked: a stuck/unfunded/offline operator simply fails its turn and the
    // NEXT operator opens the order instead — no deadlock, no double order.
    if (!(await this.orderIsInited(orderAddr))) {
      // Drift guard: our pinned order must still be the NEXT one this multisig will create.
      // If our seqno is free, WE open the order. If it advanced (a foreign order took the
      // seqno) our pinned order will never appear — waitForOrderInited then fails closed
      // rather than minting at the wrong seqno (single-purpose gateway multisig).
      const liveNext = await this.client
        .open(Multisig.createFromAddress(this.multisigAddr))
        .getOrderAddress(md.nextOrderSeqno);
      if (liveNext.equals(orderAddr)) {
        const withConfig = new Multisig(this.multisigAddr, undefined, {
          threshold: Number(md.threshold),
          signers: md.signers,
          proposers: md.proposers,
          allowArbitrarySeqno: false,
        });
        const expiration = Math.floor(Date.now() / 1000) + ORDER_TTL_SEC;
        // approve_on_init=true → the opener's own approval counts immediately.
        await this.client
          .open(withConfig)
          .sendNewOrder(sender, [transfer], expiration, this.orderValueNano, myIdx, true);
        await this.waitForOrderInited(orderAddr, proposal.actionId);
        return { orderAddr: proposal.orderAddr, myIdx, role: "propose" };
      }
      // Seqno advanced without our order appearing: wait for our pinned order (it may be
      // an in-flight open that is merely lagging) and fail closed if it never lands.
      await this.waitForOrderInited(orderAddr, proposal.actionId);
    }

    // --- Approve (order exists) ---
    const order = this.client.open(Order.createFromAddress(orderAddr));
    const od = await order.getOrderData();
    if (od.executed) return { orderAddr: proposal.orderAddr, myIdx, role: "executed" };
    if (od.approvals[myIdx]) return { orderAddr: proposal.orderAddr, myIdx, role: "already" };

    await order.sendApprove(sender, myIdx);
    await this.waitForApproval(orderAddr, myIdx, proposal.actionId);
    return { orderAddr: proposal.orderAddr, myIdx, role: "approve" };
  }

  /** Bounded poll until the order contract is deployed (proposer's new_order landed). */
  private async waitForOrderInited(orderAddr: Address, actionId: string): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    while (Date.now() < deadline) {
      if (await this.orderIsInited(orderAddr)) return;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`TON order ${orderAddr.toString()} for ${actionId} did not appear within ${this.maxWaitMs}ms`);
  }

  /** Bounded poll until this operator's approval bit is set (or the order already executed). */
  private async waitForApproval(orderAddr: Address, myIdx: number, actionId: string): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    const order = this.client.open(Order.createFromAddress(orderAddr));
    while (Date.now() < deadline) {
      const od = await order.getOrderData();
      if (od.executed || od.approvals[myIdx]) return;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`TON approval for ${actionId} (idx ${myIdx}) not reflected within ${this.maxWaitMs}ms`);
  }
}
