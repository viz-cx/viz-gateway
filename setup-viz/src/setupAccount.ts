import viz, { type Account } from "viz-js-lib";
import { loadSetupConfig } from "./config";
import { multisigAuthority } from "./authority";

/**
 * ONE-TIME setup of the VIZ gateway account's authorities. This utility is NOT
 * part of the running gateway — it configures the account once and is otherwise
 * only used in an extreme case to recover access.
 *
 * It sets:
 *   active  = the operational signer set (e.g. 1-of-1 at bootstrap, 7-of-11 later)
 *   master  = the 3-of-4 guardian council [on1x, lex, id, denis-skripnik]
 *   regular = same as active (non-fund operations)
 * and optionally change_recovery_account to a separate conservative account.
 *
 * Changing `master` requires signing with the current master key. Dry-run by
 * default; set APPLY=1 (and GATEWAY_MASTER_WIF) to broadcast.
 */
function call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => exec((err, res) => (err ? reject(err) : resolve(res))));
}

async function main(): Promise<void> {
  const cfg = loadSetupConfig();
  viz.config.set("websocket", cfg.nodeUrl);

  if (cfg.activeAccounts.length === 0 && cfg.activeKeys.length === 0) {
    throw new Error("Set ACTIVE_ACCOUNTS and/or ACTIVE_KEYS (the operational signer set).");
  }

  const active = multisigAuthority(cfg.activeAccounts, cfg.activeThreshold, cfg.activeKeys);
  const master = multisigAuthority(cfg.guardians, cfg.masterThreshold);
  const regular = active;

  // Reuse the account's current memo_key (and json_metadata) unless overridden,
  // so this update doesn't clobber them.
  let current: Account | undefined;
  try {
    const accounts = await call<Account[]>((cb) => viz.api.getAccounts([cfg.gatewayAccount], cb));
    current = accounts[0];
  } catch (err) {
    console.warn(`[setup] could not read current account: ${String(err)}`);
  }
  const memoKey = cfg.memoPubkey || current?.memo_key || "";
  if (!memoKey) throw new Error("MEMO_PUBKEY not set and current memo_key could not be read.");
  const jsonMetadata = current?.json_metadata ?? "";

  console.log(`[setup] account: ${cfg.gatewayAccount} @ ${cfg.nodeUrl}`);
  console.log(`[setup] active  (${active.weight_threshold} of ${active.account_auths.length + active.key_auths.length}):`, JSON.stringify(active));
  console.log(`[setup] master  (${master.weight_threshold} of ${master.account_auths.length}):`, JSON.stringify(master));
  console.log(`[setup] regular: = active`);
  console.log(`[setup] memo_key: ${memoKey}`);
  console.log(`[setup] recovery_account: ${cfg.recoveryAccount || "(unchanged)"}`);
  if (current) console.log(`[setup] CURRENT master on chain:`, JSON.stringify(current.master_authority));

  if (!cfg.apply) {
    console.log("\n[setup] DRY-RUN. Set APPLY=1 and GATEWAY_MASTER_WIF to broadcast (signs with the master key).");
    return;
  }
  if (!cfg.masterWif) throw new Error("GATEWAY_MASTER_WIF is required to APPLY.");

  await viz.broadcast.accountUpdateAsync(
    cfg.masterWif,
    cfg.gatewayAccount,
    master,
    active,
    regular,
    memoKey,
    jsonMetadata,
  );
  console.log("[setup] account_update broadcast: master = 3-of-4 guardians, active set updated.");

  if (cfg.recoveryAccount) {
    await viz.broadcast.changeRecoveryAccountAsync(cfg.masterWif, cfg.gatewayAccount, cfg.recoveryAccount, []);
    console.log(
      `[setup] change_recovery_account -> ${cfg.recoveryAccount} submitted (takes effect after VIZ's owner-recovery delay).`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
