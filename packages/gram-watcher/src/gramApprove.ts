import { Address, TonClient, WalletContractV4, toNano } from "@ton/ton";
import { Multisig, Order } from "@gateway/contracts-ton";
import type { GramMintProposal } from "@gateway/common";
import { buildMintTransfer, mintOrderCell } from "./gramChain";
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
 *   - exactly ONE operator (the coordinator-designated proposer) sends `new_order`
 *     with approve_on_init (its own approval counts immediately); this fixes the
 *     order seqno so all operators target the same deterministic order address;
 *   - every other operator sends `approve` at its own signer index;
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

/** The on-chain approval surface KeyedSigner depends on (injectable for tests). */
export interface GramApprovalClient {
  approveMint(proposal: GramMintProposal, isProposer: boolean): Promise<GramApprovalReceipt>;
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
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly orderValueNano: bigint;

  constructor(
    endpoint: string,
    apiKey: string,
    minterAddress: string,
    multisigAddress: string,
    private readonly mnemonic: string,
    opts: GramApproverOpts = {},
  ) {
    if (!minterAddress) throw new Error("GramApprover: minter address is required");
    if (!multisigAddress) throw new Error("GramApprover: GRAM_MULTISIG_ADDRESS is required");
    if (!mnemonic) throw new Error("GramApprover: GRAM_SIGNER_MNEMONIC is required to approve on-chain");
    this.client = new TonClient({ endpoint, apiKey: apiKey || undefined, timeout: 10000 });
    this.minter = Address.parse(minterAddress);
    this.multisigAddr = Address.parse(multisigAddress);
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

  async approveMint(proposal: GramMintProposal, isProposer: boolean): Promise<GramApprovalReceipt> {
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

    // Derive THIS operator's wallet + signer index from its own mnemonic.
    const { publicKey, secretKey } = await keyPairFromMnemonic(this.mnemonic);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(publicKey) });
    const md = await this.client.open(Multisig.createFromAddress(this.multisigAddr)).getMultisigData();
    const myIdx = md.signers.findIndex((s) => s.equals(wallet.address));
    if (myIdx < 0) {
      throw new Error(
        `TON approve: operator wallet ${wallet.address.toString()} is not in the multisig signer set`,
      );
    }

    const orderAddr = Address.parse(proposal.orderAddr);
    const openedWallet = this.client.open(wallet);
    const sender = openedWallet.sender(Buffer.from(secretKey));

    // --- Propose (only the designated proposer, only if the order is absent) ---
    if (!(await this.orderIsInited(orderAddr))) {
      if (!isProposer) {
        // Wait for the designated proposer's new_order to land, then fall through to approve.
        await this.waitForOrderInited(orderAddr, proposal.actionId);
      } else {
        // Drift guard: the order must be the NEXT one this multisig will create, or a
        // foreign order slipped in at our seqno — fail closed rather than mint at the wrong
        // seqno (single-purpose gateway multisig: nothing else should create orders).
        const liveNext = await this.client
          .open(Multisig.createFromAddress(this.multisigAddr))
          .getOrderAddress(md.nextOrderSeqno);
        if (!liveNext.equals(orderAddr)) {
          throw new Error(
            `TON propose aborted for ${proposal.actionId}: pinned order ${orderAddr.toString()} != live next ${liveNext.toString()} (seqno drift)`,
          );
        }
        const mintTransfer = buildMintTransfer(this.minter, toAddr, amountBaseUnits);
        const withConfig = new Multisig(this.multisigAddr, undefined, {
          threshold: Number(md.threshold),
          signers: md.signers,
          proposers: md.proposers,
          allowArbitrarySeqno: false,
        });
        const expiration = Math.floor(Date.now() / 1000) + ORDER_TTL_SEC;
        // approve_on_init=true → the proposer's own approval counts immediately.
        await this.client
          .open(withConfig)
          .sendNewOrder(sender, [mintTransfer], expiration, this.orderValueNano, myIdx, true);
        await this.waitForOrderInited(orderAddr, proposal.actionId);
        return { orderAddr: proposal.orderAddr, myIdx, role: "propose" };
      }
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
