import { writeFileSync } from "node:fs";
import { Address, WalletContractV4 } from "@ton/ton";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { Multisig } from "./wrappers/Multisig";
import { loadCodeBoc } from "./deploy";

/**
 * Build the init DATA cell for a fresh N-of-M multisig-contract-v2, for the §9b
 * live 3-of-5 TON proof. Two modes:
 *
 *   GEN=1  — generate M fresh 24-word wallet mnemonics, print them (save to the
 *            gitignored docs/federation-ton-keys.md), and build the data BOC from
 *            their derived v4 addresses.
 *   (else) — derive the M signer addresses from FED_OP<i>_TON_MNEMONIC already in
 *            the environment (the same mnemonics the signer processes will use).
 *
 * Signer ORDER matters — it fixes each operator's signers[index] on-chain, which
 * is what the harness relies on when it designates op-1 (index 0) the proposer.
 *
 * Env:
 *   MULTISIG_CODE_BOC   — path to the vendored multisig code cell (required)
 *   MULTISIG_THRESHOLD  — signing threshold (default 3)
 *   FED_N               — operator count (default 5)
 *   MULTISIG_DATA_OUT   — output path (default contracts/ton/boc/multisig-3of5.data.boc;
 *                         a SEPARATE file so the vendored CI multisig.data.boc is untouched)
 *   FED_OP<i>_TON_MNEMONIC — per-operator mnemonic (required unless GEN=1)
 *
 * The output path is what you then point MULTISIG_DATA_BOC at for `deploy:multisig`.
 */
async function main(): Promise<void> {
  const codeBocPath = process.env.MULTISIG_CODE_BOC;
  if (!codeBocPath) throw new Error("Set MULTISIG_CODE_BOC (path to the vendored multisig code cell).");
  const threshold = Number.parseInt(process.env.MULTISIG_THRESHOLD ?? "3", 10);
  const n = Number.parseInt(process.env.FED_N ?? "5", 10);
  const outPath = process.env.MULTISIG_DATA_OUT ?? "contracts/ton/boc/multisig-3of5.data.boc";
  if (!Number.isInteger(n) || n < 1) throw new Error(`FED_N must be a positive integer, got ${process.env.FED_N}`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > n)
    throw new Error(`MULTISIG_THRESHOLD must be in 1..${n}, got ${process.env.MULTISIG_THRESHOLD}`);

  const gen = process.env.GEN === "1";
  const mnemonics: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (gen) {
      mnemonics.push((await mnemonicNew()).join(" "));
    } else {
      const m = process.env[`FED_OP${i}_TON_MNEMONIC`];
      if (!m) throw new Error(`missing FED_OP${i}_TON_MNEMONIC (or run with GEN=1 to generate fresh wallets)`);
      mnemonics.push(m);
    }
  }

  // Derive each operator's v4 wallet address (workchain 0), preserving order.
  const signers: Address[] = [];
  for (let i = 0; i < mnemonics.length; i++) {
    const key = await mnemonicToPrivateKey(mnemonics[i]!.split(/\s+/));
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
    signers.push(wallet.address);
  }

  const code = loadCodeBoc(codeBocPath);
  const multisig = Multisig.createFromConfig(
    { threshold, signers, proposers: [], allowArbitrarySeqno: false },
    code,
  );
  const dataBoc = multisig.init!.data.toBoc();
  writeFileSync(outPath, dataBoc);

  console.log(`[gen:multisig-data] threshold      : ${threshold}-of-${n}`);
  console.log(`[gen:multisig-data] multisig addr  : ${multisig.address.toString()}`);
  console.log(`[gen:multisig-data] data BOC       : ${outPath} (${dataBoc.length} bytes)`);
  console.log(`[gen:multisig-data] signers (order fixes signers[index]):`);
  signers.forEach((a, i) => console.log(`  op-${i + 1} [${i}] : ${a.toString()}`));
  console.log(`\nNext: DEPLOY_SEND=1 MULTISIG_DATA_BOC=${outPath} \\`);
  console.log(`  MULTISIG_THRESHOLD=${threshold} MULTISIG_SIGNERS=<the ${n} addresses above> npm run deploy:multisig`);
  if (gen) {
    console.log(`\n=== GENERATED MNEMONICS — SAVE to gitignored docs/federation-ton-keys.md, do NOT commit ===`);
    mnemonics.forEach((m, i) => console.log(`FED_OP${i + 1}_TON_MNEMONIC="${m}"`));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
