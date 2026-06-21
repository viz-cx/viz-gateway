import { readFileSync } from "node:fs";
import { Cell } from "@ton/core";
import { TonClient } from "@ton/ton";
import { loadDeployConfig } from "./config";
import { computeAddress, deployStateInit, loadCodeBoc } from "./deploy";
import { deriveDeployer } from "./wallet";

/**
 * Deploy the 5-of-7 multisig (ton-blockchain/multisig-contract-v2).
 *
 * The init DATA must come from the official wrapper to guarantee the exact
 * storage layout:
 *   import { Multisig } from "<official-repo>/wrappers/Multisig";
 *   const data = Multisig.configToCell({ threshold: 5, signers, proposers: [],
 *     allowArbitrarySeqno: false }).toBoc(); // write to MULTISIG_DATA_BOC
 * We deploy whatever (code, data) you provide and never re-implement the layout.
 */
async function main(): Promise<void> {
  const cfg = loadDeployConfig();
  if (!cfg.multisigCodeBoc) throw new Error("Set MULTISIG_CODE_BOC (compiled multisig-contract-v2 code).");
  if (!cfg.multisigDataBoc)
    throw new Error(
      "Set MULTISIG_DATA_BOC (init data from the official Multisig wrapper: Multisig.configToCell({threshold,signers,proposers,allowArbitrarySeqno})).",
    );

  const code = loadCodeBoc(cfg.multisigCodeBoc);
  const dataCells = Cell.fromBoc(readFileSync(cfg.multisigDataBoc));
  const data = dataCells[0];
  if (!data) throw new Error(`No cell in MULTISIG_DATA_BOC: ${cfg.multisigDataBoc}`);

  const address = computeAddress(code, data);
  console.log(`[deploy:multisig] computed address : ${address.toString()}`);
  console.log(`[deploy:multisig] threshold        : ${cfg.multisigThreshold}-of-${cfg.multisigSigners.length || "?"}`);

  if (!cfg.send) {
    console.log("[deploy:multisig] DRY-RUN (set DEPLOY_SEND=1 to broadcast). Fund this address, then re-run.");
    return;
  }
  const { keyPair, wallet } = await deriveDeployer(cfg.deployerMnemonic);
  const client = new TonClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey || undefined });
  const deployed = await deployStateInit({ client, keyPair, wallet, code, data, value: cfg.deployValue });
  console.log(`[deploy:multisig] deploy sent to ${deployed.toString()} from ${wallet.address.toString()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
