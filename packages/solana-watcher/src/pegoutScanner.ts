import { canonicalPegOut, createStore, loadConfig } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { SolanaChain } from "./solanaChain";
import { deriveDepositKeypair } from "./depositAddress";

/**
 * peg-out scanner (Solana, Variant A). Rotates over the registered deposit
 * addresses (oldest-scanned first), detects finalized incoming wVIZ, and for each:
 *   1. BURNS the received wVIZ (supply down first -> over-backing window, safe),
 *   2. ENQUEUES a PEG_OUT release to the mapped VIZ account (no memo needed —
 *      the address IS the routing identity),
 * then the dispatcher delivers the VIZ release through the federation (T-of-N).
 *
 * Burn-before-release is deliberate: releasing first would briefly under-back the
 * peg and trip recon. Idempotency is on the Solana tx signature.
 *
 * NOTE: the burn + enqueue across two steps are not atomic; if the process dies
 * between them the burned-but-unreleased amount is recoverable from the outbox /
 * tx log (a follow-up could persist a BURNED checkpoint per signature).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.solana.wvizMint) throw new Error("SOLANA_WVIZ_MINT is required");
  if (!cfg.solana.depositMasterSeed) throw new Error("SOLANA_DEPOSIT_MASTER_SEED is required");
  if (!cfg.solana.submitterSecret) throw new Error("SOLANA_SUBMITTER_SECRET is required (pays burn fees)");

  const chain = new SolanaChain(
    cfg.solana.rpcUrl,
    cfg.solana.wvizMint,
    cfg.solana.gatewayTokenAccount,
    cfg.solana.finalitySlots,
    { multisig: cfg.solana.multisig, nonceAccount: cfg.solana.nonceAccount, submitterSecret: cfg.solana.submitterSecret },
    { maxSignatures: cfg.solana.scanMaxSignatures, txDelayMs: cfg.solana.scanTxDelayMs },
  );
  const store = createStore(cfg.storeUrl);

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[pegout-scanner] mint=${cfg.solana.wvizMint} batch=${cfg.solana.scanAddressBatch}`);

  // A PEG_OUT row left in SEEN past this means a burn whose release was never
  // queued (a crash between burn and setStatus). It can't be auto-recovered without
  // confirming on-chain whether the burn actually landed (the BURNED-checkpoint
  // follow-up), so alert for manual reconcile rather than risk a re-burn loop.
  const STALE_SEEN_MS = 5 * 60 * 1000;

  while (running) {
    try {
      if (await store.isPaused()) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      for (const s of await store.stale(Date.now(), STALE_SEEN_MS, ["SEEN"])) {
        if (s.direction === "PEG_OUT") {
          notifyStaff("withdraws", `peg-out ${s.id} stuck in SEEN (burn unconfirmed); needs manual reconcile`, {
            vizAccount: s.recipient,
            amountMilliViz: String(s.amountMilliViz),
          });
        }
      }
      const slot = await chain.finalizedHeight();
      const batch = await store.depositAddressesForScan(cfg.solana.scanAddressBatch);
      for (const dep of batch) {
        const transfers = await chain.incomingTransfersTo(dep.wvizAta, slot);
        for (const t of transfers) {
          const action = canonicalPegOut({
            sourceId: t.signature,
            height: t.slot,
            from: dep.solAddress,
            amountMilliViz: t.amountBaseUnits, // 3-decimal mint => base unit == milli-VIZ
            homeDestination: dep.vizAccount,
          });
          // Claim FIRST (atomic first-claim on the tx signature), THEN burn. A crash
          // after the burn now leaves a visible row to recover from instead of a
          // silently-lost release, and a duplicate/concurrent scan can't double-burn.
          // status SEEN = claimed but not yet burned; QUEUED = burned, ready to release.
          const first = await store.enqueue({
            id: action.id,
            direction: "PEG_OUT",
            recipient: action.recipient,
            amountMilliViz: action.amountMilliViz,
            digest: action.digest,
            status: "SEEN",
          });
          if (!first) continue; // already claimed (burned, queued, or recovering)
          try {
            // Burn first (supply down -> over-backing window, the safe direction).
            const depositKp = deriveDepositKeypair(cfg.solana.depositMasterSeed, dep.vizAccount);
            await chain.burnFromDeposit(depositKp.secretKey, t.amountBaseUnits);
            // Burned: hand to the dispatcher for the T-of-N VIZ release.
            await store.setStatus(action.id, "QUEUED");
            console.log(`[pegout-scanner] ${action.id} burned ${t.amountBaseUnits} -> release to ${dep.vizAccount}`);
          } catch (err) {
            // Burn failed (transient RPC, already-empty ATA, ...). Release the claim
            // so the next scan retries cleanly rather than stranding the row in SEEN.
            await store.delete(action.id);
            notifyStaff("withdraws", `peg-out burn failed for ${action.id}: ${String(err)}`, { vizAccount: dep.vizAccount });
          }
        }
        await store.touchDepositScan(dep.vizAccount, Date.now());
      }
    } catch (err) {
      console.error("[pegout-scanner] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  await store.close();
  console.log("[pegout-scanner] stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
