import type { CanonicalAction, VizChain, VizDeposit, VizReleaseProposal } from "@gateway/common";

/**
 * Stub VizChain. Returns safe empty results so the service runs end-to-end
 * without crashing, while clearly marking where viz-js-lib must be wired.
 *
 * To implement for real:
 *   import viz from "viz-js-lib";
 *   viz.config.set("websocket", nodeWs);
 *   - lastIrreversibleBlock(): viz.api.getDynamicGlobalProperties ->
 *       result.last_irreversible_block_num
 *   - irreversibleDepositsSince(): for each block in (from, upTo] that is <= LIB,
 *       viz.api.getOpsInBlock(blockNum, false) -> filter "transfer" ops where
 *       to === gatewayAccount; parse memo as the TON destination address;
 *       convert "1.234 VIZ" -> 1234 milli-VIZ.
 *   - gatewayBalanceMilliViz(): viz.api.getAccounts([gatewayAccount]) -> balance.
 *   - broadcastRelease(): build a transfer op signed by >= T active-authority
 *       keys (merge partial signatures), then viz.api.broadcastTransaction.
 */
export class VizChainStub implements VizChain {
  private warned = false;
  constructor(
    private readonly nodeWs: string,
    private readonly gatewayAccount: string,
  ) {}

  private warn(): void {
    if (!this.warned) {
      console.warn(
        `[viz-watcher] VizChainStub active (node=${this.nodeWs}, gateway=${this.gatewayAccount}). Wire viz-js-lib to go live.`,
      );
      this.warned = true;
    }
  }

  async lastIrreversibleBlock(): Promise<number> {
    this.warn();
    return 0;
  }

  async irreversibleDepositsSince(_fromBlock: number, _upToBlock: number): Promise<VizDeposit[]> {
    this.warn();
    return [];
  }

  async gatewayBalanceMilliViz(): Promise<bigint> {
    this.warn();
    return 0n;
  }

  async buildReleaseProposal(
    action: CanonicalAction,
    gatewayAccount: string,
  ): Promise<VizReleaseProposal> {
    throw new Error(`VizChainStub.buildReleaseProposal not implemented (action ${action.id}, gw ${gatewayAccount})`);
  }

  async broadcastRelease(_proposal: VizReleaseProposal, signatures: string[]): Promise<string> {
    throw new Error(`VizChainStub.broadcastRelease not implemented (${signatures.length} signatures)`);
  }
}
