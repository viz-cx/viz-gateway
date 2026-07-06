// tools/e2e/gram-metadata.ts — read-back + assert the deployed wVIZ minter's
// on-chain TEP-64 metadata and admin. Non-destructive (pure get-methods, no
// stack, no broadcast). Confirms what a wallet/explorer would show for wVIZ and
// that mint/burn authority sits with the multisig.
//
// Run: npm run e2e:gram:metadata
import { loadE2eConfig } from "./config";
import { readMinterData } from "./ton";

async function main() {
  const cfg = loadE2eConfig(process.env, "gram");
  console.log(`[meta] minter   : ${cfg.gram.jettonMinterAddress}`);
  console.log(`[meta] endpoint : ${cfg.gram.endpoint}`);

  const d = await readMinterData(cfg);
  console.log(`[meta] totalSupply : ${d.totalSupply} (base units / mVIZ)`);
  console.log(`[meta] mintable    : ${d.mintable}`);
  console.log(`[meta] admin       : ${d.admin}`);
  console.log(`[meta] content     :`, d.content);

  const problems: string[] = [];
  // TEP-64 required fields for a fungible token.
  if (d.content.symbol !== "wVIZ") problems.push(`symbol expected wVIZ, got ${JSON.stringify(d.content.symbol)}`);
  if (d.content.decimals !== "3") problems.push(`decimals expected 3, got ${JSON.stringify(d.content.decimals)}`);
  if (!d.content.name) problems.push("name is empty");
  if (!d.content.description) problems.push("description is empty");

  // Icon: an empty image renders as a blank token in wallets/explorers. On testnet
  // this is a WARNING (the round trip works without it), but it MUST be set before
  // mainnet — surface it loudly either way.
  const hasIcon = Boolean(d.content.image);
  console.log(hasIcon ? `[meta] icon set : ${d.content.image}` : "[meta] ⚠️  icon NOT set (image is empty) — blank token in wallets/explorers; set WVIZ_IMAGE before mainnet");

  // Admin must be the multisig — only a threshold of operators can mint/burn.
  const adminIsMultisig = d.admin === cfg.gram.multisigAddress;
  if (!adminIsMultisig) problems.push(`admin ${d.admin} != multisig ${cfg.gram.multisigAddress} — mint/burn authority is NOT held by the federation`);
  else console.log(`[meta] admin == multisig ✓ (only ${cfg.gram.multisigAddress} can mint/burn)`);

  if (problems.length) {
    console.error(`[meta] FAILED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[meta] OK — wVIZ metadata + admin verified on-chain${hasIcon ? "" : " (icon gap noted)"}`);
}

main().catch((err) => {
  console.error(`[meta] FAILED: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
