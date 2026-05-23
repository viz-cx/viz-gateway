import type { TonBurn, TonChain, TonMintProposal } from "@gateway/common";

/**
 * Stub TonChain. Returns safe empty results so the service runs without
 * crashing, while marking where @ton/ton must be wired.
 *
 * To implement for real:
 *   import { TonClient, Address } from "@ton/ton";
 *   const client = new TonClient({ endpoint, apiKey });
 *   - masterchainSeqno(): client.getMasterchainInfo() -> last.seqno
 *   - finalBurnsSince(): scan the gateway Jetton wallet / minter for burn
 *       notifications (op = burn_notification) included up to a final mc block;
 *       parse the comment cell as the VIZ destination account; amounts are in
 *       jetton base units -> convert to milli-VIZ.
 *   - circulatingSupplyMilliViz(): call get_jetton_data on the minter ->
 *       total_supply.
 *   - submitMintOrder(): build a multisig-v2 "order" calling mint on the minter
 *       (admin = multisig); attach >= T signer approvals; send via the multisig.
 */
export class TonChainStub implements TonChain {
  private warned = false;
  constructor(
    private readonly endpoint: string,
    private readonly minter: string,
  ) {}

  private warn(): void {
    if (!this.warned) {
      console.warn(
        `[ton-watcher] TonChainStub active (endpoint=${this.endpoint}, minter=${this.minter || "unset"}). Wire @ton/ton to go live.`,
      );
      this.warned = true;
    }
  }

  async masterchainSeqno(): Promise<number> {
    this.warn();
    return 0;
  }

  async finalBurnsSince(_fromSeqno: number, _mcSeqno: number): Promise<TonBurn[]> {
    this.warn();
    return [];
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    this.warn();
    return 0n;
  }

  async submitMintOrder(proposal: TonMintProposal, signatures: string[]): Promise<string> {
    throw new Error(
      `TonChainStub.submitMintOrder not implemented (order ${proposal.orderSeqno}, ${signatures.length} approvals)`,
    );
  }
}
