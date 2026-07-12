import { Address, toNano } from "@ton/core";

function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
}
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface DeployConfig {
  endpoint: string;
  apiKey: string;
  deployerMnemonic: string;
  send: boolean; // DEPLOY_SEND=1 actually broadcasts; otherwise dry-run (address only)
  deployValue: bigint;

  // multisig
  multisigCodeBoc: string;
  multisigDataBoc: string; // built by the official wrapper (Multisig.configToCell)
  multisigThreshold: number;
  multisigSigners: Address[];

  // jetton minter
  minterCodeBoc: string;
  jettonWalletCodeBoc: string;
  minterDataBoc: string; // optional override
  initialAdmin: string; // friendly address; usually the deployer, then handed off

  // metadata
  wviz: { name: string; symbol: string; decimals: string; description: string; image: string };

  // handoff
  minterAddress: string;
  multisigAddress: string;
}

function parseAddresses(csv: string): Address[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Address.parse(s));
}

export function loadDeployConfig(): DeployConfig {
  return {
    endpoint: opt("TON_ENDPOINT", "https://toncenter.com/api/v2/jsonRPC"),
    apiKey: opt("TON_API_KEY", ""),
    deployerMnemonic: opt("DEPLOYER_MNEMONIC", ""),
    send: opt("DEPLOY_SEND", "0") === "1",
    deployValue: toNano(opt("DEPLOY_VALUE_TON", "0.5")),

    multisigCodeBoc: opt("MULTISIG_CODE_BOC", ""),
    multisigDataBoc: opt("MULTISIG_DATA_BOC", ""),
    multisigThreshold: Number.parseInt(opt("MULTISIG_THRESHOLD", "5"), 10),
    multisigSigners: parseAddresses(opt("MULTISIG_SIGNERS", "")),

    minterCodeBoc: opt("JETTON_MINTER_CODE_BOC", ""),
    jettonWalletCodeBoc: opt("JETTON_WALLET_CODE_BOC", ""),
    minterDataBoc: opt("JETTON_MINTER_DATA_BOC", ""),
    initialAdmin: opt("JETTON_INITIAL_ADMIN", ""),

    wviz: {
      name: opt("WVIZ_NAME", "Wrapped VIZ"),
      symbol: opt("WVIZ_SYMBOL", "wVIZ"),
      decimals: opt("WVIZ_DECIMALS", "3"),
      description: opt(
        "WVIZ_DESCRIPTION",
        "Bridge claim on VIZ locked in the gateway multisig. 1 wVIZ = 1 VIZ.",
      ),
      image: opt("WVIZ_IMAGE", "https://avatars.githubusercontent.com/u/37064345?s=200&v=4"),
    },

    minterAddress: opt("MINTER_ADDRESS", ""),
    multisigAddress: opt("MULTISIG_ADDRESS", ""),
  };
}

export { req };
