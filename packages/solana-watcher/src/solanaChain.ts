import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createBurnInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { RemoteBurn, RemoteChain, SolanaMintProposal } from "@gateway/common";
import { buildSignedMintTx, mintMessageB64 } from "./solanaSign";

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

/** RPC scan throttling/pagination (avoid 429 on public/free-tier RPC). */
export interface SolanaScanOpts {
  /** Max signatures fetched per scan call. */
  maxSignatures?: number;
  /** Delay (ms) between per-tx getParsedTransaction calls. */
  txDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Base58 pubkey for a solana-keygen secret (used by recon's reserve monitor). */
export function pubkeyOf(secret: Uint8Array): string {
  return Keypair.fromSecretKey(secret).publicKey.toBase58();
}

export class SolanaChain implements RemoteChain<SolanaMintProposal> {
  private readonly conn: Connection;
  private readonly mint: PublicKey;
  private readonly gatewayTokenAccount: PublicKey | null;
  /** Confirmations buffer in slots, on top of 'finalized'. */
  private readonly finalitySlots: number;
  private readonly maxSignatures: number;
  private readonly txDelayMs: number;
  /** Write-path (mint) config; null on read-only watchers. */
  private readonly writer: {
    multisig: string;
    nonceAccount: string;
    submitterSecret: Uint8Array;
  } | null;

  constructor(
    rpcUrl: string,
    mintAddress: string,
    gatewayTokenAccount: string,
    finalitySlots: number,
    writer: { multisig: string; nonceAccount: string; submitterSecret: Uint8Array } | null = null,
    scan: SolanaScanOpts = {},
  ) {
    this.conn = new Connection(rpcUrl, "finalized");
    this.mint = new PublicKey(mintAddress);
    this.gatewayTokenAccount = gatewayTokenAccount ? new PublicKey(gatewayTokenAccount) : null;
    this.finalitySlots = Math.max(0, finalitySlots);
    this.maxSignatures = Math.max(1, scan.maxSignatures ?? 25);
    this.txDelayMs = Math.max(0, scan.txDelayMs ?? 0);
    this.writer = writer;
  }

  async finalizedHeight(): Promise<number> {
    return this.conn.getSlot("finalized");
  }

  async circulatingSupplyMilliViz(): Promise<bigint> {
    // 3-decimal mint => base-unit amount IS milli-VIZ. `amount` is a string of base units.
    const supply = await this.conn.getTokenSupply(this.mint, "finalized");
    return BigInt(supply.value.amount);
  }

  /** Does the recipient's wVIZ ATA already exist? (else the gateway pays its rent). */
  async isDestinationProvisioned(recipient: string): Promise<boolean> {
    const ata = getAssociatedTokenAddressSync(this.mint, new PublicKey(recipient), false, TOKEN_2022_PROGRAM_ID);
    const info = await this.conn.getAccountInfo(ata);
    return info !== null && info.data.length > 0;
  }

  /** Native SOL balance (lamports) of an address — for the submitter reserve monitor. */
  async solBalanceLamports(pubkey: string): Promise<number> {
    return this.conn.getBalance(new PublicKey(pubkey));
  }

  /**
   * Burn wVIZ received on a peg-out deposit ATA (Variant A, E5). MUST run BEFORE
   * the VIZ release so circulating supply drops first (over-backing window, safe);
   * releasing before burning would briefly under-back and trip recon. The deposit
   * keypair is the token-account owner (burn authority); the submitter pays fees.
   */
  async burnFromDeposit(depositSecret: Uint8Array, amountBaseUnits: bigint): Promise<string> {
    if (!this.writer) throw new Error("SolanaChain has no writer config; cannot burn");
    const deposit = Keypair.fromSecretKey(depositSecret);
    const submitter = Keypair.fromSecretKey(this.writer.submitterSecret);
    const ata = getAssociatedTokenAddressSync(this.mint, deposit.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = createBurnInstruction(ata, this.mint, deposit.publicKey, amountBaseUnits, [], TOKEN_2022_PROGRAM_ID);
    const { blockhash } = await this.conn.getLatestBlockhash();
    const tx = new Transaction();
    tx.feePayer = submitter.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(ix);
    tx.sign(submitter, deposit);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await this.confirmSignature(sig);
    return sig;
  }

  async finalizedBurnsSince(_fromSlot: number, toSlot: number): Promise<RemoteBurn[]> {
    if (!this.gatewayTokenAccount) return [];
    const safeSlot = toSlot - this.finalitySlots;
    const sigs = await this.conn.getSignaturesForAddress(this.gatewayTokenAccount, {
      limit: this.maxSignatures,
    });
    const burns: RemoteBurn[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      if (s.slot > safeSlot) continue; // not yet final per the buffer
      // Throttle between per-tx parses to stay under RPC rate limits (429).
      if (this.txDelayMs > 0) await sleep(this.txDelayMs);
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

  /**
   * Scan a SPECIFIC token account (a peg-out deposit ATA, Variant A) for finalized
   * incoming wVIZ transfers. Same parse/throttle as finalizedBurnsSince but keyed
   * on the per-recipient ATA instead of the single gateway account.
   */
  async incomingTransfersTo(
    ata: string,
    toSlot: number,
  ): Promise<Array<{ signature: string; slot: number; amountBaseUnits: bigint }>> {
    const safeSlot = toSlot - this.finalitySlots;
    const acct = new PublicKey(ata);
    const sigs = await this.conn.getSignaturesForAddress(acct, { limit: this.maxSignatures });
    const out: Array<{ signature: string; slot: number; amountBaseUnits: bigint }> = [];
    for (const s of sigs) {
      if (s.err) continue;
      if ((s.slot ?? 0) > safeSlot) continue;
      if (this.txDelayMs > 0) await sleep(this.txDelayMs);
      const tx = await this.conn.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "finalized",
      });
      if (!tx) continue;
      const parsed = parseGatewayDeposit(tx, ata);
      if (!parsed) continue;
      out.push({ signature: s.signature, slot: s.slot ?? 0, amountBaseUnits: parsed.amountBaseUnits });
    }
    return out;
  }

  async submitMint(proposal: SolanaMintProposal, mintAuth: string[]): Promise<string> {
    if (!this.writer) throw new Error("SolanaChain has no writer config; cannot submit a mint");
    if (proposal.signers.length === 0) throw new Error("proposal has no signers");
    if (mintAuth.length < proposal.signers.length) {
      throw new Error(
        `mintAuth has ${mintAuth.length} signatures; proposal requires all ${proposal.signers.length}`,
      );
    }
    const raw = buildSignedMintTx(proposal, mintAuth, this.writer.submitterSecret);
    const sig = await this.conn.sendRawTransaction(raw, { skipPreflight: false });
    // Wait for the cluster to confirm before returning, so the caller does not
    // treat a dropped tx as a successful mint. Durable-nonce txs have no
    // blockhash expiry, so we poll signature status rather than tie to a
    // blockhash/lastValidBlockHeight strategy. Best-effort: on timeout we still
    // return the signature (recon's supply read is the final backstop).
    await this.confirmSignature(sig);
    return sig;
  }

  /** Poll a signature to 'confirmed'. Throws on on-chain error; returns on timeout. */
  private async confirmSignature(signature: string, attempts = 30, delayMs = 1000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const { value } = await this.conn.getSignatureStatus(signature, {
        searchTransactionHistory: false,
      });
      if (value?.err) {
        throw new Error(`mint tx ${signature} failed on-chain: ${JSON.stringify(value.err)}`);
      }
      if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
        return;
      }
      await sleep(delayMs);
    }
  }

  /**
   * Proposer side: build the shared mint proposal for a PEG_IN. Fetches the
   * durable nonce (live RPC), derives the recipient ATA, and pins the exact
   * message bytes every operator will sign. `netMilliViz` is the post-fee amount
   * to mint and `destProvisioned` is the pinned ATA-existence flag (both computed
   * by the coordinator from gross + fee policy). `signerSet` is the chosen signing
   * subset (size = threshold M); all of them must sign.
   */
  async buildMintProposal(
    recipient: string,
    netMilliViz: bigint,
    destProvisioned: boolean,
    signerSet: string[],
  ): Promise<SolanaMintProposal> {
    if (!this.writer) throw new Error("SolanaChain has no writer config; cannot build a mint proposal");
    const nonce = await this.conn.getNonce(new PublicKey(this.writer.nonceAccount));
    if (!nonce) throw new Error(`nonce account ${this.writer.nonceAccount} not found`);
    const proposal: SolanaMintProposal = {
      recipient,
      amountMilliViz: netMilliViz.toString(),
      destProvisioned,
      mint: this.mint.toBase58(),
      multisig: this.writer.multisig,
      signers: [...signerSet].sort(),
      feePayer: Keypair.fromSecretKey(this.writer.submitterSecret).publicKey.toBase58(),
      nonceAccount: this.writer.nonceAccount,
      nonceValue: nonce.nonce,
      decimals: 3,
      messageB64: "",
    };
    proposal.messageB64 = mintMessageB64(proposal);
    return proposal;
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
 *
 * Scans BOTH the top-level message instructions AND `meta.innerInstructions`:
 * transfers routed through a program (CPI — swap routers, aggregators, etc.) live
 * in inner instructions and would otherwise be missed, losing the user's funds.
 * Refine field access against real devnet transactions for your token program.
 */
export function parseGatewayDeposit(
  tx: {
    transaction: { message: { instructions: unknown[] } };
    meta?: { innerInstructions?: Array<{ instructions: unknown[] }> | null } | null;
  },
  gatewayTokenAccount: string,
): GatewayDeposit | null {
  const ixs = [...(tx.transaction.message.instructions as Array<Record<string, unknown>>)];
  for (const group of tx.meta?.innerInstructions ?? []) {
    ixs.push(...(group.instructions as Array<Record<string, unknown>>));
  }
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
