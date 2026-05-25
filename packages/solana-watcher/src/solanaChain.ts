import { Connection, PublicKey } from "@solana/web3.js";
import type { RemoteBurn, RemoteChain, SolanaMintProposal } from "@gateway/common";

/**
 * Solana remote-chain adapter (read paths live; mint write-path deferred).
 *
 * wVIZ on Solana is an SPL Token-2022 mint (3 decimals) whose mint authority is
 * an SPL M-of-N multisig (or Squads). Peg-out works like the TON side: a user
 * sends wVIZ to the gateway's token account with a memo = their VIZ account.
 *
 * Verified against devnet: getSlot('finalized') and getTokenSupply read live.
 * Burn detection parsing should be validated on devnet with a real wVIZ mint.
 */

/** Memo program id (used to carry the VIZ destination on a peg-out transfer). */
const MEMO_PROGRAM_ID = "MemoSq4gq4PtfDg1xv9JaY9Cz9c6Tn3ANk6tDsj4hf"; // SPL Memo v2

export class SolanaChain implements RemoteChain<SolanaMintProposal> {
  private readonly conn: Connection;
  private readonly mint: PublicKey;
  private readonly gatewayTokenAccount: PublicKey | null;
  /** Confirmations buffer in slots, on top of 'finalized'. */
  private readonly finalitySlots: number;

  constructor(
    rpcUrl: string,
    mintAddress: string,
    gatewayTokenAccount: string,
    finalitySlots: number,
  ) {
    this.conn = new Connection(rpcUrl, "finalized");
    this.mint = new PublicKey(mintAddress);
    this.gatewayTokenAccount = gatewayTokenAccount ? new PublicKey(gatewayTokenAccount) : null;
    this.finalitySlots = Math.max(0, finalitySlots);
  }

  async finalizedHeight(): Promise<number> {
    return this.conn.getSlot("finalized");
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    // 3-decimal mint => base-unit amount IS milli-VIZ. `amount` is a string of base units.
    const supply = await this.conn.getTokenSupply(this.mint, "finalized");
    return BigInt(supply.value.amount);
  }

  async finalizedBurnsSince(_fromSlot: number, toSlot: number): Promise<RemoteBurn[]> {
    if (!this.gatewayTokenAccount) return [];
    const safeSlot = toSlot - this.finalitySlots;
    const sigs = await this.conn.getSignaturesForAddress(this.gatewayTokenAccount, { limit: 25 });
    const burns: RemoteBurn[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      if (s.slot > safeSlot) continue; // not yet final per the buffer
      const tx = await this.conn.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "finalized",
      });
      if (!tx) continue;
      const parsed = parseGatewayDeposit(tx, this.gatewayTokenAccount.toBase58());
      if (!parsed) continue;
      burns.push({
        sourceId: s.signature,
        height: s.slot,
        from: parsed.from,
        amountMilliViz: parsed.amountBaseUnits,
        homeDestination: parsed.memo.trim(),
      });
    }
    return burns;
  }

  async submitMint(proposal: SolanaMintProposal, _mintAuth: string[]): Promise<string> {
    // Deferred: build a mint_to instruction with the SPL multisig as authority,
    // collect M signer signatures on the one transaction (off-chain, like VIZ),
    // and submit. Wire after the TON round-trip validates RemoteChain.
    throw new Error(
      `Solana submitMint deferred (recipient ${proposal.recipient}). SPL multisig mint = ` +
        `M signatures on one tx; wire after TON validates the interface. See plan §13.`,
    );
  }
}

interface GatewayDeposit {
  from: string;
  amountBaseUnits: bigint;
  memo: string;
}

/**
 * Extract an incoming SPL token transfer into the gateway token account plus its
 * memo (the VIZ destination). Uses parsed-instruction shapes from getParsedTransaction.
 * Refine field access against real devnet transactions for your token program.
 */
export function parseGatewayDeposit(
  tx: { transaction: { message: { instructions: unknown[] } } },
  gatewayTokenAccount: string,
): GatewayDeposit | null {
  const ixs = tx.transaction.message.instructions as Array<Record<string, unknown>>;
  let amount: bigint | null = null;
  let from = "";
  let memo = "";
  for (const ix of ixs) {
    const program = ix["program"] as string | undefined;
    const programId = (ix["programId"] as { toString?: () => string } | undefined)?.toString?.();
    if (program === "spl-memo" || programId === MEMO_PROGRAM_ID) {
      memo = String((ix as { parsed?: unknown }).parsed ?? "");
      continue;
    }
    if (program === "spl-token" || program === "spl-token-2022") {
      const parsed = ix["parsed"] as { type?: string; info?: Record<string, unknown> } | undefined;
      if (!parsed?.info) continue;
      const type = parsed.type;
      const info = parsed.info;
      if ((type === "transfer" || type === "transferChecked") && info["destination"] === gatewayTokenAccount) {
        const amt = (info["tokenAmount"] as { amount?: string } | undefined)?.amount ?? (info["amount"] as string | undefined);
        if (amt) amount = BigInt(amt);
        from = String(info["authority"] ?? info["source"] ?? "");
      }
    }
  }
  if (amount === null) return null;
  return { from, amountBaseUnits: amount, memo };
}
