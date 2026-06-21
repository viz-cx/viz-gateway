function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
}
function list(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} is not an integer: ${v}`);
  return n;
}

export interface SetupConfig {
  nodeUrl: string;
  gatewayAccount: string;
  masterWif: string; // current master key; only needed to APPLY

  // Operational (active) signer set — accounts and/or raw public keys.
  activeAccounts: string[];
  activeKeys: string[];
  activeThreshold: number;

  // Guardian (master) set — the fixed recovery council.
  guardians: string[];
  masterThreshold: number;

  recoveryAccount: string;
  memoPubkey: string; // optional override; otherwise current memo_key is reused
  apply: boolean;
}

export function loadSetupConfig(): SetupConfig {
  return {
    nodeUrl: opt("VIZ_NODE_URL", "https://node.viz.cx"),
    gatewayAccount: opt("GATEWAY_ACCOUNT", "viz-gateway"),
    masterWif: opt("GATEWAY_MASTER_WIF", ""),

    activeAccounts: list(opt("ACTIVE_ACCOUNTS", "")),
    activeKeys: list(opt("ACTIVE_KEYS", "")),
    activeThreshold: int("ACTIVE_THRESHOLD", 1),

    // The guardian council (last-resort recovery only). No default — must be set
    // explicitly so a deployment never silently inherits example validator names.
    guardians: list(opt("MASTER_GUARDIANS", "")),
    masterThreshold: int("MASTER_THRESHOLD", 3),

    recoveryAccount: opt("RECOVERY_ACCOUNT", ""),
    memoPubkey: opt("MEMO_PUBKEY", ""),
    apply: opt("APPLY", "0") === "1",
  };
}
