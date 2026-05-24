import { Address, JettonMaster, TonClient } from "@ton/ton";
import type { Slice } from "@ton/core";
import type { TonBurn, TonChain, TonMintProposal } from "@gateway/common";

/**
 * Live TON read path via toncenter (HTTP API v2). Read-only methods need no
 * keys; submitMintOrder (the write path) is implemented in a later phase.
 *
 * Peg-out model (symmetric with the VIZ side): a user sends wVIZ to the
 * gateway's Jetton wallet WITH a text comment = their VIZ account. The gateway
 * wallet receives a TEP-74 `transfer_notification` (op 0x7362d09c) carrying
 * amount, sender, and the forward payload (the comment). We later burn those
 * wVIZ and release VIZ. This carries the destination cleanly, exactly like the
 * VIZ deposit memo.
 *
 * Verified against toncenter: getMasterchainInfo().latestSeqno and
 * JettonMaster.getJettonData().totalSupply both read live. The
 * transfer_notification parser is verified by a constructed round-trip
 * (tools/ton-notification-spike.cjs) since no wVIZ jetton exists yet.
 */

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;

/** Read a TEP-74 transfer_notification body: returns amount, sender, comment. */
export function parseTransferNotification(
  body: Slice,
): { amountBaseUnits: bigint; sender: string; comment: string } | null {
  if (body.remainingBits < 32) return null;
  const op = body.loadUint(32);
  if (op !== OP_TRANSFER_NOTIFICATION) return null;
  body.loadUintBig(64); // query_id
  const amountBaseUnits = body.loadCoins();
  const sender = body.loadAddress().toString();
  // forward_payload: Either inline (bit 0) or in a ref (bit 1).
  const fp: Slice = body.loadBit() ? body.loadRef().beginParse() : body;
  let comment = "";
  if (fp.remainingBits >= 32) {
    const tag = fp.loadUint(32);
    if (tag === 0) comment = fp.loadStringTail(); // text comment (first cell; snake refs TODO)
  }
  return { amountBaseUnits, sender, comment };
}

export class TonHttpChain implements TonChain {
  private readonly client: TonClient;
  private readonly minter: Address;
  private readonly gatewayWallet: Address | null;
  /** wVIZ uses 3 decimals to match VIZ, so 1 base unit == 1 milli-VIZ. */
  private readonly finalityBufferSec: number;

  constructor(
    endpoint: string,
    apiKey: string,
    minterAddress: string,
    gatewayJettonWallet: string,
    finalityConfirmations: number,
  ) {
    this.client = new TonClient({ endpoint, apiKey: apiKey || undefined, timeout: 10000 });
    this.minter = Address.parse(minterAddress);
    this.gatewayWallet = gatewayJettonWallet ? Address.parse(gatewayJettonWallet) : null;
    // ~5s per masterchain block; convert the confirmation count to a time buffer.
    this.finalityBufferSec = Math.max(6, finalityConfirmations * 5 + 5);
  }

  async masterchainSeqno(): Promise<number> {
    return (await this.client.getMasterchainInfo()).latestSeqno;
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    const master = this.client.open(JettonMaster.create(this.minter));
    const data = await master.getJettonData();
    return data.totalSupply; // 3-decimal jetton => base units are milli-VIZ
  }

  async finalBurnsSince(_fromSeqno: number, mcSeqno: number): Promise<TonBurn[]> {
    if (!this.gatewayWallet) return [];
    const cutoff = Math.floor(Date.now() / 1000) - this.finalityBufferSec;
    const txs = await this.client.getTransactions(this.gatewayWallet, { limit: 20 });
    const burns: TonBurn[] = [];
    for (const tx of txs) {
      if (tx.now > cutoff) continue; // not yet final per the time buffer
      const inMsg = tx.inMessage;
      if (!inMsg || inMsg.body.bits.length === 0) continue;
      const parsed = parseTransferNotification(inMsg.body.beginParse());
      if (!parsed) continue;
      burns.push({
        msgHash: tx.hash().toString("hex"),
        mcSeqno,
        from: parsed.sender,
        amountMilliViz: parsed.amountBaseUnits,
        vizDestination: parsed.comment.trim(),
      });
    }
    return burns;
  }

  async submitMintOrder(proposal: TonMintProposal, signatures: string[]): Promise<string> {
    // IMPORTANT — multisig-v2 approvals are ON-CHAIN, not off-chain signatures.
    // To mint, the proposer sends a `new_order` to the multisig carrying the
    // mint action (mint wVIZ to proposal.toAddress for proposal.amountMilliViz);
    // each signer then approves by sending an `approve` message FROM the address
    // at signers[index] (or the proposer approves on init). At threshold the
    // order executes the mint. For a 1-of-1 bootstrap this is a single
    // new_order with approve_on_init=true from your signer wallet.
    //
    // So `signatures` (the off-chain ed25519 model) does NOT apply here; the real
    // integration creates/approves the order via the official Multisig wrapper.
    // See RUNBOOK.md ("How peg-in mint works on TON").
    throw new Error(
      `submitMintOrder: multisig-v2 mint is an on-chain new_order + approve flow via the ` +
        `Multisig wrapper (order ${proposal.orderSeqno}, to ${proposal.toAddress}). See RUNBOOK.md.`,
    );
  }
}
