import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadSolanaProgramAuthorityConfig } from "./config";
import {
  buildSetUpgradeAuthorityIx,
  deriveProgramDataAddress,
  evaluateUpgradeAuthority,
  parseProgramAccount,
  parseUpgradeAuthority,
} from "./programAuthority";

/**
 * H3: verify (and optionally hand off) the gateway-deposit program's BPF upgrade authority.
 *
 * The equivalent of `solana program show <programId>` (read the ProgramData account, print slot +
 * upgrade authority), plus a fail-closed check that the authority is the federation's M-of-N multisig
 * — because whoever can upgrade this program can drain every deposit ATA (the burn-only guarantee is
 * only as strong as the program's immutability).
 *
 * Dry-run by default: reads on-chain, prints the verdict, exits non-zero if the authority is UNSAFE or
 * MISCONFIGURED so CI/operators notice. Set APPLY=1 + SOLANA_PAYER_SECRET (the CURRENT authority) to
 * reassign the authority to SOLANA_UPGRADE_MULTISIG. Making the program fully non-upgradeable
 * (authority → None) is the eventual step and is intentionally NOT automated here.
 *
 * NOT TESTED ON A LIVE CLUSTER: no local solana-test-validator is available in this environment. The
 * account parsing, PDA derivation, and the SetAuthority instruction layout are covered offline by
 * tools/solana-upgrade-authority-spike.cjs; the send path must be dry-run on devnet before mainnet.
 */
async function main(): Promise<void> {
  const cfg = loadSolanaProgramAuthorityConfig();
  if (!cfg.programId) throw new Error("SOLANA_DEPOSIT_PROGRAM_ID required.");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const programId = new PublicKey(cfg.programId);
  const programDataAddress = deriveProgramDataAddress(programId);

  console.log(`[solana:authority] rpc: ${cfg.rpcUrl}`);
  console.log(`[solana:authority] program:      ${programId.toBase58()}`);
  console.log(`[solana:authority] programData:  ${programDataAddress.toBase58()}`);

  // Cross-check: the program account must actually point at the ProgramData PDA we derived.
  const programAcct = await conn.getAccountInfo(programId);
  if (!programAcct) throw new Error(`program ${programId.toBase58()} not found on ${cfg.rpcUrl}`);
  const declaredProgramData = parseProgramAccount(programAcct.data);
  if (!declaredProgramData.equals(programDataAddress)) {
    throw new Error(
      `program's ProgramData ${declaredProgramData.toBase58()} != derived ${programDataAddress.toBase58()} — unexpected loader state`,
    );
  }

  const programDataAcct = await conn.getAccountInfo(programDataAddress);
  if (!programDataAcct) throw new Error(`programData ${programDataAddress.toBase58()} not found — is the program upgradeable?`);
  const { slot, upgradeAuthority } = parseUpgradeAuthority(programDataAcct.data);
  console.log(`[solana:authority] last deployed slot: ${slot}`);
  console.log(`[solana:authority] upgrade authority:  ${upgradeAuthority ?? "None (immutable)"}`);
  console.log(`[solana:authority] expected multisig:  ${cfg.expectedMultisig || "(unset)"}`);

  const verdict = evaluateUpgradeAuthority({
    current: upgradeAuthority,
    expectedMultisig: cfg.expectedMultisig,
    payer: cfg.payer?.publicKey.toBase58() ?? null,
  });
  console.log(`[solana:authority] verdict: ${verdict.status} — ${verdict.reason}`);

  if (verdict.ok) {
    console.log("[solana:authority] OK — upgrade authority is safe.");
    return;
  }

  // UNSAFE or MISCONFIGURED. Only offer the automated hand-off when we hold the current authority.
  if (!cfg.apply) {
    console.error(
      "\n[solana:authority] FAIL-CLOSED: upgrade authority is not the federation multisig." +
        (verdict.canHandoff
          ? "\n  Set APPLY=1 + SOLANA_PAYER_SECRET (the current authority) to hand it off to SOLANA_UPGRADE_MULTISIG."
          : "\n  Cannot auto-fix: fix SOLANA_UPGRADE_MULTISIG, or have the CURRENT authority reassign it."),
    );
    process.exit(2);
  }

  if (!verdict.canHandoff) {
    throw new Error(
      `cannot hand off: current authority ${upgradeAuthority ?? "None"} is not the payer ` +
        `${cfg.payer?.publicKey.toBase58() ?? "(no payer)"} — only the current authority may reassign it`,
    );
  }
  if (!cfg.payer) throw new Error("SOLANA_PAYER_SECRET required to APPLY.");

  const newAuthority = new PublicKey(cfg.expectedMultisig);
  const tx = new Transaction().add(
    buildSetUpgradeAuthorityIx({
      programDataAddress,
      currentAuthority: cfg.payer.publicKey,
      newAuthority,
    }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [cfg.payer]);
  console.log(`[solana:authority] SetAuthority sent: ${sig}`);

  // Re-read and verify the hand-off actually landed (never trust the send alone).
  const after = await conn.getAccountInfo(programDataAddress);
  if (!after) throw new Error("programData vanished after SetAuthority");
  const post = parseUpgradeAuthority(after.data).upgradeAuthority;
  if (post !== cfg.expectedMultisig) {
    throw new Error(`hand-off FAILED: authority is ${post ?? "None"}, expected ${cfg.expectedMultisig}`);
  }
  console.log(`[solana:authority] verified: upgrade authority is now the multisig ${cfg.expectedMultisig}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
