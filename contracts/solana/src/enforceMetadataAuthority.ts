import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadSolanaMetadataAuthorityConfig } from "./config";
import {
  MetadataAuthorityState,
  buildMetadataHandoffIxs,
  evaluateMetadataAuthority,
  isSplTokenMultisigAccount,
} from "./metadataAuthority";

/**
 * Verify (and optionally hand off) the wVIZ mint's Token-2022 metadata authorities — the
 * MetadataPointer authority and the token-metadata updateAuthority, both left on the deploy payer
 * by deployMint.ts. Companion to enforceProgramAuthority.ts, same contract:
 *
 * Dry-run by default: reads on-chain, prints the verdict, SIMULATES the exact hand-off transaction
 * against the live cluster (unsigned, so no secret is needed — this is the differential proof that
 * the write path executes before anyone signs it), and exits 2 if the authorities are UNSAFE or
 * MISCONFIGURED so CI/operators notice. Set APPLY=1 + SOLANA_PAYER_SECRET (the CURRENT authority)
 * to reassign both to SOLANA_METADATA_AUTHORITY.
 *
 * SOLANA_METADATA_AUTHORITY must be a key or PDA that can actually SIGN token-metadata instructions
 * (e.g. the Squads v4 vault PDA, which signs via CPI) — NOT the SPL token multisig that gates
 * mint/freeze; see metadataAuthority.ts. A fail-closed guard refuses such a target outright.
 *
 * Offline coverage: tools/solana-metadata-authority-spike.cjs (verdict, multisig-target guard,
 * instruction layouts). The send path must be dry-run on devnet before mainnet.
 */
async function readMint(conn: Connection, mint: PublicKey): Promise<MetadataAuthorityState & { name: string; symbol: string }> {
  const r = await conn.getParsedAccountInfo(mint, "confirmed");
  const data = r.value?.data;
  const info = data && "parsed" in data
    ? (data.parsed as { info?: { extensions?: Array<{ extension: string; state: Record<string, unknown> }> } }).info
    : undefined;
  if (!info) throw new Error(`mint ${mint.toBase58()} not found or not jsonParsed`);
  const out: MetadataAuthorityState & { name: string; symbol: string } = { updateAuthority: null, pointerAuthority: null, name: "", symbol: "" };
  for (const ext of info.extensions ?? []) {
    if (ext.extension === "tokenMetadata") {
      const s = ext.state as { updateAuthority?: string; name?: string; symbol?: string };
      out.updateAuthority = s.updateAuthority ?? null;
      out.name = s.name ?? "";
      out.symbol = s.symbol ?? "";
    } else if (ext.extension === "metadataPointer") {
      out.pointerAuthority = (ext.state as { authority?: string }).authority ?? null;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cfg = loadSolanaMetadataAuthorityConfig();
  if (!cfg.mint) throw new Error("SOLANA_WVIZ_MINT required.");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const mint = new PublicKey(cfg.mint);
  const state = await readMint(conn, mint);

  console.log(`[solana:metadata] rpc: ${cfg.rpcUrl}`);
  console.log(`[solana:metadata] mint: ${mint.toBase58()} (${state.name} / ${state.symbol})`);
  console.log(`[solana:metadata] metadata updateAuthority:  ${state.updateAuthority ?? "None (frozen)"}`);
  console.log(`[solana:metadata] metadataPointer authority: ${state.pointerAuthority ?? "None (frozen)"}`);
  console.log(`[solana:metadata] expected authority:        ${cfg.expected || "(unset)"}`);

  const verdict = evaluateMetadataAuthority({
    state,
    expected: cfg.expected,
    payer: cfg.payer?.publicKey.toBase58() ?? null,
  });
  console.log(`[solana:metadata] verdict: ${verdict.status} — ${verdict.reason}`);
  if (verdict.ok) {
    console.log("[solana:metadata] OK — metadata authorities are safe.");
    return;
  }

  // Fail-closed guard: an SPL token multisig can never be `is_signer` for token-metadata
  // instructions — handing off to one would succeed on-chain and freeze metadata forever.
  const targetAcct = await conn.getAccountInfo(new PublicKey(cfg.expected));
  if (targetAcct && isSplTokenMultisigAccount(targetAcct.owner.toBase58(), targetAcct.data.length)) {
    throw new Error(
      `SOLANA_METADATA_AUTHORITY ${cfg.expected} is an SPL token multisig account — token-metadata ` +
        `instructions require the authority itself to sign, which a multisig cannot do. Use the Squads ` +
        `vault PDA (or another CPI-signing authority) instead, or metadata updates are bricked forever.`,
    );
  }

  const tx = new Transaction();
  for (const ix of buildMetadataHandoffIxs({ mint, state, newAuthority: new PublicKey(cfg.expected) })) tx.add(ix);
  if (tx.instructions.length === 0) throw new Error("UNSAFE verdict but nothing to move — unexpected state");

  if (!cfg.apply) {
    // Prove the write path on the live cluster without any secret: simulate the exact unsigned
    // hand-off tx (sigVerify is off for unsigned simulations, so the current authority's signature
    // is assumed). A clean simulation is the go/no-go evidence for APPLY.
    tx.feePayer = new PublicKey(state.pointerAuthority ?? state.updateAuthority!);
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      console.error(`[solana:metadata] hand-off simulation FAILED: ${JSON.stringify(sim.value.err)}`);
      for (const l of sim.value.logs ?? []) console.error(`  ${l}`);
    } else {
      console.log(`[solana:metadata] hand-off simulation OK (${tx.instructions.length} ix) — write path executes cleanly.`);
    }
    console.error(
      "\n[solana:metadata] FAIL-CLOSED: metadata authorities are not the federation authority." +
        (verdict.canHandoff
          ? "\n  Set APPLY=1 + SOLANA_PAYER_SECRET (the current authority) to hand them off to SOLANA_METADATA_AUTHORITY."
          : "\n  Cannot auto-fix: fix SOLANA_METADATA_AUTHORITY, or have the CURRENT authority reassign them."),
    );
    process.exit(2);
  }

  if (!verdict.canHandoff) {
    throw new Error(
      `cannot hand off: current authorities (update=${state.updateAuthority ?? "None"}, pointer=${state.pointerAuthority ?? "None"}) ` +
        `are not the payer ${cfg.payer?.publicKey.toBase58() ?? "(no payer)"} — only the current authority may reassign them`,
    );
  }
  if (!cfg.payer) throw new Error("SOLANA_PAYER_SECRET required to APPLY.");

  const sig = await sendAndConfirmTransaction(conn, tx, [cfg.payer]);
  console.log(`[solana:metadata] hand-off sent: ${sig}`);

  // Re-read and verify the hand-off actually landed (never trust the send alone). A field that was
  // already None stays None — the evaluator, not a raw equality, is the source of truth.
  const after = await readMint(conn, mint);
  if (!evaluateMetadataAuthority({ state: after, expected: cfg.expected }).ok) {
    throw new Error(
      `hand-off FAILED: update=${after.updateAuthority ?? "None"} pointer=${after.pointerAuthority ?? "None"}, expected ${cfg.expected}`,
    );
  }
  console.log(`[solana:metadata] verified: metadata authorities are now ${cfg.expected}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
