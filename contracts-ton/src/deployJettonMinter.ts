import { readFileSync } from "node:fs";
import { Address, Cell } from "@ton/core";
import { TonClient } from "@ton/ton";
import { loadDeployConfig } from "./config";
import { computeAddress, deployStateInit, loadCodeBoc } from "./deploy";
import { buildWvizContent } from "./metadata";
import { buildStandardMinterData } from "./minter";
import { deriveDeployer } from "./wallet";

/**
 * Deploy the wVIZ Jetton minter.
 *
 * Recommended: deploy ton-blockchain/stablecoin-contract and provide its init
 * data via JETTON_MINTER_DATA_BOC (built by that repo's wrapper). If you instead
 * use the standard governed minter, this script can build the data for you from
 * the wVIZ metadata + wallet code (buildStandardMinterData).
 *
 * Deploy admin = the deployer initially; hand it to the multisig afterwards with
 * `npm run set-minter-admin` so only 5-of-7 can mint/burn.
 */
async function main(): Promise<void> {
  const cfg = loadDeployConfig();
  if (!cfg.minterCodeBoc) throw new Error("Set JETTON_MINTER_CODE_BOC (compiled minter code).");

  const code = loadCodeBoc(cfg.minterCodeBoc);
  const content = buildWvizContent(cfg.wviz);

  let data: Cell;
  if (cfg.minterDataBoc) {
    const cells = Cell.fromBoc(readFileSync(cfg.minterDataBoc));
    const d = cells[0];
    if (!d) throw new Error(`No cell in JETTON_MINTER_DATA_BOC: ${cfg.minterDataBoc}`);
    data = d;
    console.log("[deploy:minter] using JETTON_MINTER_DATA_BOC (wrapper-built init data)");
  } else {
    if (!cfg.jettonWalletCodeBoc) throw new Error("Set JETTON_WALLET_CODE_BOC or provide JETTON_MINTER_DATA_BOC.");
    if (!cfg.initialAdmin) throw new Error("Set JETTON_INITIAL_ADMIN (usually the deployer address).");
    const walletCode = loadCodeBoc(cfg.jettonWalletCodeBoc);
    data = buildStandardMinterData(Address.parse(cfg.initialAdmin), content, walletCode);
    console.log("[deploy:minter] built standard governed-minter init data (validate vs. your contract)");
  }

  const address = computeAddress(code, data);
  console.log(`[deploy:minter] computed address : ${address.toString()}`);
  console.log(`[deploy:minter] metadata         : ${cfg.wviz.symbol} (${cfg.wviz.decimals} decimals)`);

  if (!cfg.send) {
    console.log("[deploy:minter] DRY-RUN (set DEPLOY_SEND=1 to broadcast). Fund this address, then re-run.");
    return;
  }
  const { keyPair, wallet } = await deriveDeployer(cfg.deployerMnemonic);
  const client = new TonClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey || undefined });
  const deployed = await deployStateInit({ client, keyPair, wallet, code, data, value: cfg.deployValue });
  console.log(`[deploy:minter] deploy sent to ${deployed.toString()} from ${wallet.address.toString()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
