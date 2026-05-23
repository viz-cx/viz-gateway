import { Address } from "@ton/core";
import { TonClient } from "@ton/ton";
import { loadDeployConfig } from "./config";
import { sendInternal } from "./deploy";
import { changeAdminBody } from "./minter";
import { deriveDeployer } from "./wallet";

/**
 * Hand the Jetton minter's admin to the multisig, so from then on only a 5-of-7
 * consensus can mint or burn wVIZ. Run this AFTER deploying both contracts and
 * AFTER verifying the multisig works.
 *
 * NOTE: change_admin op here is the standard governed-minter op (3). The
 * stablecoin-contract uses a different (often two-step) admin transfer — use its
 * op/body if you deployed that one.
 */
async function main(): Promise<void> {
  const cfg = loadDeployConfig();
  if (!cfg.minterAddress) throw new Error("Set MINTER_ADDRESS.");
  if (!cfg.multisigAddress) throw new Error("Set MULTISIG_ADDRESS (the new admin).");

  const minter = Address.parse(cfg.minterAddress);
  const newAdmin = Address.parse(cfg.multisigAddress);
  const body = changeAdminBody(newAdmin);

  console.log(`[set-minter-admin] minter    : ${minter.toString()}`);
  console.log(`[set-minter-admin] new admin : ${newAdmin.toString()} (multisig)`);
  console.log(`[set-minter-admin] body hash : ${body.hash().toString("hex")}`);

  if (!cfg.send) {
    console.log("[set-minter-admin] DRY-RUN (set DEPLOY_SEND=1 to broadcast).");
    return;
  }
  const { keyPair, wallet } = await deriveDeployer(cfg.deployerMnemonic);
  const client = new TonClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey || undefined });
  await sendInternal({ client, keyPair, wallet, to: minter, value: cfg.deployValue, body });
  console.log(`[set-minter-admin] change_admin sent from ${wallet.address.toString()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
