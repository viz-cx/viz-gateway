import type { RemoteChainId } from "./types";

/**
 * The chain↔account registry. Security-critical: since the receiving account
 * determines the mint chain, a wrong/ambiguous mapping would mint on the wrong
 * chain or mis-attribute backing. Validated fail-closed at construction.
 */
export class GatewayAccounts {
  private readonly byChain: Map<RemoteChainId, string>;
  private readonly byAccount: Map<string, RemoteChainId>;

  constructor(map: Record<RemoteChainId, string>) {
    this.byChain = new Map();
    this.byAccount = new Map();
    for (const [chain, account] of Object.entries(map) as [RemoteChainId, string][]) {
      if (!account) throw new Error(`[gateway-accounts] missing/empty account for chain ${chain}`);
      if (this.byAccount.has(account)) {
        throw new Error(
          `[gateway-accounts] account ${account} maps to both ${this.byAccount.get(account)} and ${chain} — ` +
            `backing accounts must be distinct (injective) or isolation is defeated`,
        );
      }
      this.byChain.set(chain, account);
      this.byAccount.set(account, chain);
    }
    if (this.byChain.size === 0) throw new Error("[gateway-accounts] empty registry");
  }

  accountFor(chain: RemoteChainId): string {
    const a = this.byChain.get(chain);
    if (!a) throw new Error(`[gateway-accounts] no backing account for chain ${chain}`);
    return a;
  }

  chainFor(account: string): RemoteChainId {
    const c = this.byAccount.get(account);
    if (!c) throw new Error(`[gateway-accounts] unmapped account ${account} — refusing to route`);
    return c;
  }

  isBackingAccount(account: string): boolean {
    return this.byAccount.has(account);
  }

  all(): string[] {
    return [...this.byAccount.keys()];
  }
}
