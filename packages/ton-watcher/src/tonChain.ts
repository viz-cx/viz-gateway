import { Address, JettonMaster, TonClient, internal, SendMode, WalletContractV4, toNano } from "@ton/ton";
import { beginCell } from "@ton/core";
import type { Slice, Transaction } from "@ton/core";
import type { RemoteBurn, RemoteChain, TonMintProposal } from "@gateway/common";
import { Multisig } from "@gateway/contracts-ton";
import { keyPairFromMnemonic } from "./tonSign";

/**
 * Live TON chain adapter. Read path: finalized burns, jetton balances.
 * Write path: submit the multisig-v2 new_order that mints wVIZ (peg-in).
 *
 * Peg-out model: user sends wVIZ to the gateway's Jetton wallet with a text
 * comment = their VIZ account. The gateway receives a TEP-74
 * transfer_notification (0x7362d09c) carrying amount, sender, and the
 * forward payload (comment). The watcher enqueues a VIZ release.
 *
 * Verified against toncenter: getMasterchainInfo().latestSeqno and
 * JettonMaster.getJettonData().totalSupply both read live. The
 * transfer_notification parser is verified by a constructed round-trip
 * (tools/ton-notification-spike.cjs).
 */

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
// Standard governed-minter op codes (ton-blockchain/token-contract).
const OP_MINT = 21;
const OP_INTERNAL_TRANSFER = 0x178d4519;
// TTL for a new multisig order (1 hour should cover any signing latency).
const ORDER_TTL_SEC = 3600;

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
    if (tag === 0) comment = fp.loadStringTail(); // text comment
  }
  return { amountBaseUnits, sender, comment };
}

export class TonHttpChain implements RemoteChain<TonMintProposal> {
  private readonly client: TonClient;
  private readonly minter: Address;
  private readonly gatewayWallet: Address | null;
  private readonly multisigAddress: string;
  private readonly signerMnemonic: string;
  private readonly finalityBufferSec: number;
  private readonly maxTransactions: number;

  constructor(
    endpoint: string,
    apiKey: string,
    minterAddress: string,
    gatewayJettonWallet: string,
    multisigAddress: string,
    signerMnemonic: string,
    finalityConfirmations: number,
    maxTransactions = 20,
  ) {
    this.client = new TonClient({ endpoint, apiKey: apiKey || undefined, timeout: 10000 });
    this.minter = Address.parse(minterAddress);
    this.gatewayWallet = gatewayJettonWallet ? Address.parse(gatewayJettonWallet) : null;
    this.multisigAddress = multisigAddress;
    this.signerMnemonic = signerMnemonic;
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
    const parsed = parseTransferNotification(inMsg.body.beginParse());
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
   * Submit a multisig-v2 new_order that mints `proposal.amountMilliViz` wVIZ
   * (= base units, 3 decimals) to `proposal.toAddress` via the standard governed
   * jetton minter. For a 1-of-1 setup, `approve_on_init=true` executes the mint
   * in the same transaction. For M-of-N, remaining signers must send on-chain
   * `approve` messages to the returned order address.
   *
   * Off-chain ed25519 signatures in `_mintAuth` are NOT used here (TON uses
   * on-chain approvals, not off-chain sigs). They are collected by the signer
   * service for audit purposes and future M-of-N on-chain approval routing.
   *
   * Returns the multisig order address (hex string) for status tracking.
   */
  async submitMint(proposal: TonMintProposal, _mintAuth: string[]): Promise<string> {
    if (!this.multisigAddress) throw new Error("TON_MULTISIG_ADDRESS is required for submitMint");
    if (!this.signerMnemonic) throw new Error("TON_SIGNER_MNEMONIC is required for submitMint");

    const c = this.client;
    const multisigAddr = Address.parse(this.multisigAddress);
    const toAddr = Address.parse(proposal.toAddress);
    const amountBaseUnits = BigInt(proposal.amountMilliViz);

    // Build the standard governed-minter mint body (OP=21).
    // master_msg: the jetton wallet internal_transfer (TEP-74 op 0x178d4519).
    const masterMsg = beginCell()
      .storeUint(OP_INTERNAL_TRANSFER, 32)
      .storeUint(0n, 64) // query_id
      .storeCoins(amountBaseUnits) // jetton amount (base units = milli-VIZ)
      .storeAddress(this.minter) // from = minter
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

    // Build the multisig TransferRequest: send the mint message from the multisig to the minter.
    const mintTransfer = {
      type: "transfer" as const,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      message: internal({ to: this.minter, value: toNano("0.1"), body: mintBody }),
    };

    // Fetch the current multisig state for sendNewOrder validation.
    const dataMultisig = c.open(Multisig.createFromAddress(multisigAddr));
    const data = await dataMultisig.getMultisigData();

    const { secretKey, publicKey } = await keyPairFromMnemonic(this.signerMnemonic);
    const signerWallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(publicKey) });

    const myIdx = data.signers.findIndex((s) => s.equals(signerWallet.address));
    if (myIdx < 0) {
      throw new Error(
        `TON signer wallet ${signerWallet.address.toString()} not found in multisig signers`,
      );
    }

    const orderAddr = await dataMultisig.getOrderAddress(data.nextOrderSeqno);

    // Re-open with synthesised config so sendNewOrder's signer-index validation passes.
    const multisigWithConfig = new Multisig(multisigAddr, undefined, {
      threshold: Number(data.threshold),
      signers: data.signers,
      proposers: data.proposers,
      allowArbitrarySeqno: false,
    });
    const openedMultisig = c.open(multisigWithConfig);
    const openedWallet = c.open(signerWallet);
    const sender = openedWallet.sender(Buffer.from(secretKey));

    const expiration = Math.floor(Date.now() / 1000) + ORDER_TTL_SEC;
    // approve_on_init=true: in a 1-of-1 setup the proposer self-approves and the
    // order executes immediately. For M-of-N the remaining signers must call
    // order.sendApprove() on-chain; that routing is deferred.
    await openedMultisig.sendNewOrder(sender, [mintTransfer], expiration, toNano("1"), myIdx, true);

    return orderAddr.toString();
  }
}
