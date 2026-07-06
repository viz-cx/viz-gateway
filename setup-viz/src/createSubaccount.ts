import viz, { type Account, type ChainProperties } from "viz-js-lib";
import { multisigAuthority } from "./authority";

/**
 * ONE-TIME creation of a fresh VIZ gateway subaccount (e.g. `gram.gate`,
 * `fees.gate`) from its parent account. Dotted names are subaccounts — only the
 * parent (`gate`) can create `something.gate`, signing with the parent's active key.
 *
 * It creates the account with:
 *   active  = the 2-of-3 operator signer set (ACTIVE_KEYS / ACTIVE_THRESHOLD)
 *   master  = the recovery authority; DEFAULTS to the same 2-of-3 as active
 *             (override with MASTER_KEYS / MASTER_THRESHOLD). NEVER a single key —
 *             master can rewrite active, so a single-key master is a backdoor around
 *             the threshold. multisigAuthority + this default keep master >= active.
 *   regular = same as active
 *   memo_key = MEMO_PUBKEY
 *
 * Dry-run by default. Set APPLY=1 (and CREATOR_WIF = the parent's active key) to
 * broadcast. The creation fee is read live from the chain unless CREATE_FEE overrides.
 *
 * ⚠️ Create the account BEFORE funding it. Fund only once the 2-of-3 authority is
 *    confirmed on chain — never hold value under a bootstrap/single key.
 *
 * Env:
 *   VIZ_NODE_URL       — node (default https://node.viz.cx)
 *   CREATOR_ACCOUNT    — parent account that creates + pays (e.g. gate) [required]
 *   CREATOR_WIF        — parent active key; only needed to APPLY
 *   NEW_ACCOUNT_NAME   — subaccount to create (e.g. gram.gate) [required]
 *   ACTIVE_KEYS        — comma-separated operator public keys [required]
 *   ACTIVE_THRESHOLD   — active signing threshold (default 2)
 *   MASTER_KEYS        — override master keys (default: = ACTIVE_KEYS)
 *   MASTER_THRESHOLD   — master threshold (default: = ACTIVE_THRESHOLD)
 *   MEMO_PUBKEY        — memo public key [required]
 *   CREATE_FEE         — override creation fee (default: chain account_creation_fee)
 *   DELEGATION         — SHARES delegation (default "0.000000 SHARES")
 *   APPLY=1            — broadcast (else dry-run)
 */
function call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => exec((err, res) => (err ? reject(err) : resolve(res))));
}
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

async function main(): Promise<void> {
  const nodeUrl = opt("VIZ_NODE_URL", "https://node.viz.cx");
  const creator = opt("CREATOR_ACCOUNT", "");
  const creatorWif = opt("CREATOR_WIF", "");
  const newAccountName = opt("NEW_ACCOUNT_NAME", "");
  const activeKeys = list(opt("ACTIVE_KEYS", ""));
  const activeThreshold = int("ACTIVE_THRESHOLD", 2);
  const masterKeys = list(opt("MASTER_KEYS", "")); // default to active below
  const masterThreshold = int("MASTER_THRESHOLD", activeThreshold);
  const memoPubkey = opt("MEMO_PUBKEY", "");
  const delegation = opt("DELEGATION", "0.000000 SHARES");
  const apply = opt("APPLY", "0") === "1";

  if (!creator) throw new Error("Set CREATOR_ACCOUNT (the parent account that creates the subaccount).");
  if (!newAccountName) throw new Error("Set NEW_ACCOUNT_NAME (the subaccount to create, e.g. gram.gate).");
  if (activeKeys.length === 0) throw new Error("Set ACTIVE_KEYS (the operator public keys for the active set).");
  if (!memoPubkey) throw new Error("Set MEMO_PUBKEY (the memo public key).");

  // Dotted names are subaccounts: the suffix after the last dot must be the creator.
  if (newAccountName.includes(".")) {
    const parent = newAccountName.slice(newAccountName.lastIndexOf(".") + 1);
    if (parent !== creator)
      throw new Error(
        `subaccount ${newAccountName} must be created by its parent '${parent}', but CREATOR_ACCOUNT='${creator}'.`,
      );
  }

  const active = multisigAuthority([], activeThreshold, activeKeys);
  // master defaults to the same 2-of-3 as active — never a single key (it can rewrite active).
  const master = masterKeys.length > 0 ? multisigAuthority([], masterThreshold, masterKeys) : active;
  const regular = active;

  const totalMasterWeight = master.key_auths.length + master.account_auths.length;
  if (master.weight_threshold < 2 && totalMasterWeight < 2)
    throw new Error(
      `refusing single-key master: master is a backdoor around the ${activeThreshold}-of-${activeKeys.length} active set. Use >= 2 keys/threshold.`,
    );

  viz.config.set("websocket", nodeUrl);

  // Fail closed if the account already exists — creation is one-time.
  const existing = await call<Account[]>((cb) => viz.api.getAccounts([newAccountName], cb));
  if (existing.length > 0 && existing[0]?.name === newAccountName)
    throw new Error(`account ${newAccountName} already exists — refusing to recreate.`);

  let fee = opt("CREATE_FEE", "");
  if (!fee) {
    const props = await call<ChainProperties>((cb) => viz.api.getChainProperties(cb));
    fee = props.account_creation_fee;
  }

  console.log(`[create] node           : ${nodeUrl}`);
  console.log(`[create] creator        : ${creator}`);
  console.log(`[create] new account    : ${newAccountName}`);
  console.log(`[create] fee            : ${fee}  (delegation: ${delegation})`);
  console.log(`[create] active  (${active.weight_threshold} of ${active.key_auths.length}) :`, JSON.stringify(active));
  console.log(`[create] master  (${master.weight_threshold} of ${master.key_auths.length + master.account_auths.length}) :`, JSON.stringify(master));
  console.log(`[create] regular : = active`);
  console.log(`[create] memo_key       : ${memoPubkey}`);

  if (!apply) {
    console.log("\n[create] DRY-RUN. Set APPLY=1 and CREATOR_WIF (parent active key) to broadcast.");
    console.log("[create] ⚠️  Do NOT fund this account until the 2-of-3 authority is confirmed on chain.");
    return;
  }
  if (!creatorWif) throw new Error("CREATOR_WIF (the parent's active key) is required to APPLY.");

  await viz.broadcast.accountCreateAsync(
    creatorWif,
    fee,
    delegation,
    creator,
    newAccountName,
    master,
    active,
    regular,
    memoPubkey,
    "",
    "",
  );
  console.log(`\n[create] account_create broadcast: ${newAccountName} created at ${active.weight_threshold}-of-${active.key_auths.length}.`);
  console.log("[create] ⚠️  Fund only after confirming the authority hash on chain.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
