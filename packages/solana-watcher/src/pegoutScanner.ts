import { buildGatewayAccounts, canonicalPegOut, CircuitBreaker, createStore, loadConfig } from "@gateway/common";
import { notifyStaff } from "@gateway/log";
import { VizJsChain } from "@gateway/viz-watcher/dist/vizChain";
import { Keypair } from "@solana/web3.js";
import { SolanaChain } from "./solanaChain";
import { classifySeenRecovery, guardPegOut } from "./pegoutGuard";

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
  if (!cfg.solana.submitterSecret) throw new Error("SOLANA_SUBMITTER_SECRET is required (pays burn fees)");
  if (!cfg.solana.depositProgramId) throw new Error("SOLANA_DEPOSIT_PROGRAM_ID is required");

  const submitter = Keypair.fromSecretKey(cfg.solana.submitterSecret);

  const chain = new SolanaChain(
    cfg.solana.rpcUrl,
    cfg.solana.wvizMint,
    cfg.solana.gatewayTokenAccount,
    cfg.solana.finalitySlots,
    { multisig: cfg.solana.multisig, nonceAccount: cfg.solana.nonceAccount, submitterSecret: cfg.solana.submitterSecret },
    { maxSignatures: cfg.solana.scanMaxSignatures, txDelayMs: cfg.solana.scanTxDelayMs },
    cfg.solana.depositProgramId,
  );
  const accounts = buildGatewayAccounts(cfg);
  const store = createStore(cfg.storeUrl);
  // Same shared rolling-24h caps the watchers apply, so a large deposit-address
  // peg-out can't burn + release uncapped.
  const breaker = new CircuitBreaker(cfg.caps, store);
  // Read-only VIZ node, used ONLY to confirm the release target exists before the
  // irreversible burn. A release to a non-existent account would never land and,
  // with PEG_OUT never refunding, would lose the user's wVIZ permanently.
  const viz = new VizJsChain(cfg.viz.nodeUrl, accounts);

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[pegout-scanner] mint=${cfg.solana.wvizMint} batch=${cfg.solana.scanAddressBatch} deposit program=${cfg.solana.depositProgramId}`);

  // A PEG_OUT row left in SEEN past this is a crash between burn and the QUEUED
  // hand-off. The scanner checkpoints the burn signature onto the row (txid) right
  // after burning, so recovery is decidable: if the checkpointed signature landed,
  // hand it to the dispatcher (QUEUED); if it never landed, release the claim and
  // retry; if there is no checkpoint (crashed at/before burn) it can't be auto-
  // decided, so alert once for manual reconcile.
  const STALE_SEEN_MS = 5 * 60 * 1000;
  // Ids already alerted on, so a wedged no-checkpoint row doesn't storm every loop.
  const alertedSeen = new Set<string>();

  while (running) {
    try {
      if (await store.isPaused()) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      for (const s of await store.stale(Date.now(), STALE_SEEN_MS, ["SEEN"])) {
        if (s.direction !== "PEG_OUT") continue;
        let landed = false;
        if (s.txid) {
          try {
            landed = await chain.signatureLanded(s.txid);
          } catch (err) {
            console.warn(`[pegout-scanner] could not check burn ${s.txid} for ${s.id}: ${String(err)}`);
            continue; // transient RPC; retry next loop
          }
        }
        const recovery = classifySeenRecovery(Boolean(s.txid), landed);
        if (recovery === "REQUEUE") {
          await store.setStatus(s.id, "QUEUED");
          alertedSeen.delete(s.id);
          console.log(`[pegout-scanner] recovered burned-but-unqueued ${s.id} (burn ${s.txid}) -> QUEUED`);
        } else if (recovery === "RELEASE") {
          await store.delete(s.id);
          alertedSeen.delete(s.id);
          console.warn(`[pegout-scanner] burn ${s.txid} for ${s.id} never landed; released claim to retry`);
        } else if (!alertedSeen.has(s.id)) {
          notifyStaff("withdraws", `peg-out ${s.id} stuck in SEEN (burn unconfirmed); needs manual reconcile`, {
            vizAccount: s.recipient,
            amountMilliViz: String(s.amountMilliViz),
          });
          alertedSeen.add(s.id);
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

          // Validate BEFORE the irreversible burn (caps + release-target existence).
          // On failure leave the wVIZ un-burned in the deposit ATA (recoverable) and
          // park the row in HELD rather than burning blind. accountExists is only
          // read when the caps pass (skip the RPC otherwise).
          const cap = await breaker.check(action.amountMilliViz);
          const guard = guardPegOut(cap, cap.ok ? await viz.accountExists(dep.vizAccount) : false);
          if (!guard.burn) {
            await store.setStatus(action.id, "HELD", { lastError: guard.reason });
            notifyStaff("withdraws", `peg-out ${action.id} held (${guard.reason}); not burned`, {
              vizAccount: dep.vizAccount,
              amountMilliViz: String(action.amountMilliViz),
            });
            if (guard.pause) await store.pause(guard.pause); // shared, cross-process
            continue;
          }

          try {
            // Burn first (supply down -> over-backing window, the safe direction). The burn is
            // permissionless and harmless: the program has no transfer path, so this cannot
            // redirect funds. The submitter signs only the tx fee. burnFromDeposit returns
            // optimistically after sendRawTransaction; confirmation is handled by the stale-SEEN
            // recovery path above (signatureLanded) so a dropped tx is retried on next scan.
            const burnSig = await chain.burnFromDeposit({ vizAccount: dep.vizAccount, amount: t.amountBaseUnits, payer: submitter });
            await breaker.record(action.amountMilliViz); // count only burns that actually happened
            // Checkpoint the burn signature (still SEEN) BEFORE the QUEUED hand-off, so a
            // crash in the gap is self-healing: stale-SEEN recovery checks whether it landed.
            await store.setStatus(action.id, "SEEN", { txid: burnSig });
            // Burned + checkpointed: hand to the dispatcher for the T-of-N VIZ release.
            await store.setStatus(action.id, "QUEUED");
            console.log(`[pegout-scanner] ${action.id} burned ${t.amountBaseUnits} (${burnSig}) -> release to ${dep.vizAccount}`);
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
