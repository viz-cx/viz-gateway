/**
 * Hand off the Token-2022 on-mint metadata authorities from the deploy payer to the
 * SPL multisig that already gates mint/freeze (Bkyv7EU75…).
 *
 * Two authorities move (both currently the deploy payer, per deployMint.ts):
 *   1. MetadataPointer authority  -> target multisig  (SetAuthority, AuthorityType::MetadataPointer)
 *   2. Metadata updateAuthority   -> target multisig  (UpdateMetadata with newUpdateAuthority)
 *
 * Fail-closed dry-run by default. APPLY=1 + SOLANA_PAYER_SECRET (the current authority) to broadcast.
 * Reads the mint via jsonParsed and verifies after the hand-off (never trust the send alone).
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createSetAuthorityInstruction,
} from '@solana/spl-token';
import { createUpdateAuthorityInstruction } from '@solana/spl-token-metadata';

type Cfg = {
  rpcUrl: string;
  mint: PublicKey;
  target: PublicKey; // multisig to receive metadataPointer + updateAuthority
  payer: Keypair | undefined;
  apply: boolean;
};

type MintInfo = {
  updateAuthority: string | null;
  pointerAuthority: string | null;
  name: string;
  symbol: string;
};

function loadCfg(): Cfg {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL required');
  const mint = process.env.SOLANA_WVIZ_MINT;
  if (!mint) throw new Error('SOLANA_WVIZ_MINT required (the wVIZ mint)');
  const target = process.env.SOLANA_METADATA_AUTHORITY;
  if (!target) throw new Error('SOLANA_METADATA_AUTHORITY required (target SPL multisig)');
  const apply = process.env.APPLY === '1';
  let payer: Keypair | undefined;
  if (apply) {
    if (!process.env.SOLANA_PAYER_SECRET) throw new Error('SOLANA_PAYER_SECRET required to APPLY');
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_PAYER_SECRET)));
  }
  return { rpcUrl, mint: new PublicKey(mint), target: new PublicKey(target), payer, apply };
}

async function readMint(conn: Connection, mint: PublicKey): Promise<MintInfo> {
  const r = await conn.getParsedAccountInfo(mint, 'confirmed');
  const data = r.value?.data;
  const info = data && 'parsed' in data
    ? (data.parsed as { info?: { extensions?: Array<{ extension: string; state: Record<string, unknown> }> } }).info
    : undefined;
  if (!info) throw new Error(`mint ${mint.toBase58()} not found or not jsonParsed`);
  let updateAuthority: string | null = null;
  let pointerAuthority: string | null = null;
  let name = '';
  let symbol = '';
  for (const ext of info.extensions ?? []) {
    if (ext.extension === 'tokenMetadata') {
      const s = ext.state as { updateAuthority?: string; name?: string; symbol?: string };
      updateAuthority = s.updateAuthority ?? null;
      name = s.name ?? '';
      symbol = s.symbol ?? '';
    } else if (ext.extension === 'metadataPointer') {
      const s = ext.state as { authority?: string };
      pointerAuthority = s.authority ?? null;
    }
  }
  return { updateAuthority, pointerAuthority, name, symbol };
}

async function main() {
  const cfg = loadCfg();
  const conn = new Connection(cfg.rpcUrl, 'confirmed');
  const state = await readMint(conn, cfg.mint);

  console.log(`[solana:metadata] rpc: ${cfg.rpcUrl}`);
  console.log(`[solana:metadata] mint: ${cfg.mint.toBase58()} (${state.name} / ${state.symbol})`);
  console.log(`[solana:metadata] metadata updateAuthority: ${state.updateAuthority ?? 'None'}`);
  console.log(`[solana:metadata] metadataPointer authority: ${state.pointerAuthority ?? 'None'}`);
  console.log(`[solana:metadata] target multisig: ${cfg.target.toBase58()}`);

  const target = cfg.target.toBase58();
  const alreadySecured =
    (state.updateAuthority === null || state.updateAuthority === target) &&
    (state.pointerAuthority === null || state.pointerAuthority === target);
  if (alreadySecured) {
    console.log('\n[solana:metadata] SECURED: metadata authorities are already on the multisig.');
    return;
  }

  const payerPub = cfg.payer?.publicKey.toBase58();
  const cannotHandoff =
    !cfg.payer ||
    (state.updateAuthority !== null && state.updateAuthority !== payerPub) ||
    (state.pointerAuthority !== null && state.pointerAuthority !== payerPub);
  if (cannotHandoff) {
    throw new Error(
      `cannot hand off: current authorities (update=${state.updateAuthority ?? 'None'}, pointer=${state.pointerAuthority ?? 'None'}) ` +
        `are not the payer ${payerPub ?? '(no payer)'} — only the current authorities may reassign them`,
    );
  }

  const tx = new Transaction();
  if (state.pointerAuthority !== null && state.pointerAuthority === payerPub) {
    tx.add(
      createSetAuthorityInstruction(
        cfg.mint,
        cfg.payer!.publicKey, // current metadataPointer authority
        AuthorityType.MetadataPointer,
        cfg.target,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (state.updateAuthority !== null && state.updateAuthority === payerPub) {
    tx.add(
      createUpdateAuthorityInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: cfg.mint, // on-mint metadata (metadataAddress == mint)
        oldAuthority: cfg.payer!.publicKey,
        newAuthority: cfg.target,
      }),
    );
  }
  if (tx.instructions.length === 0) {
    console.log('\n[solana:metadata] nothing to do.');
    return;
  }

  const sig = await sendAndConfirmTransaction(conn, tx, [cfg.payer!]);
  console.log(`[solana:metadata] hand-off sent: ${sig}`);

  const after = await readMint(conn, cfg.mint);
  if (
    (after.updateAuthority !== null && after.updateAuthority !== target) ||
    (after.pointerAuthority !== null && after.pointerAuthority !== target)
  ) {
    throw new Error(
      `hand-off FAILED: update=${after.updateAuthority ?? 'None'} pointer=${after.pointerAuthority ?? 'None'}, expected ${target}`,
    );
  }
  console.log(`[solana:metadata] verified: metadata authorities are now ${target}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
