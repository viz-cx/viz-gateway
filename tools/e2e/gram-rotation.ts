// tools/e2e/gram-rotation.ts — LIVE criterion 4 for RUNBOOK §9b: multisig signer-set
// rotation drops an operator, and the dropped operator's on-chain `approve` is
// rejected (err 106 unauthorized_sign) while the retained set still reaches
// threshold.
//
// This is the live counterpart of the sandbox rejection proof in
// tools/gram-onchain-approval-spike.cjs. It drives the full rotation ceremony
// directly against the deployed multisig (the same primitives as
// contracts/ton/src/rotateTon.ts), then creates a fresh order under the rotated
// set to prove the dropped operator can no longer authorize it.
//
// SAFETY: this PERMANENTLY rotates the deployed testnet multisig (3-of-5 -> 3-of-4).
// It is the last criterion for that reason; re-running the suite needs a freshly
// deployed 3-of-5 (RUNBOOK §9b step 0-1).
import { TonClient, WalletContractV4, type Sender } from "@ton/ton";
import { Address, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Multisig, Order, buildUpdateAction, sameSignerSet, type MultisigConfig } from "@gateway/contracts-ton";
import type { OperatorRef } from "@gateway/common";
import type { E2eConfig } from "./config";
import { pollUntil } from "./poll";

// Rotation is a chain of sequential on-chain messages (new_order + approvals +
// execution, twice over), each needing a confirmation round-trip through a flaky
// toncenter. Windows are generous for the same reason the mint windows are.
const ORDER_LANDS_TIMEOUT_MS = 6 * 60_000;
const EXECUTE_TIMEOUT_MS = 8 * 60_000;
const SEQNO_TIMEOUT_MS = 4 * 60_000;
const REJECTION_HOLD_MS = 90_000; // how long a rejected approve is held to NOT count
const POLL_MS = 5_000;

// The proposer sends TWO new_orders (rotation + test), each attaching this to fund
// the order contract (surplus flows to the multisig, not back to the proposer). The
// update/mint actions need ~0.1 TON + gas; 0.3 keeps the proposer's drain low so a
// lightly-funded proposer covers the ceremony. Approvers/dropped only send a single
// ~0.1 TON approve. Matches GRAM_ORDER_VALUE_NANO in federation-ton-live.ts.
const NEW_ORDER_VALUE = toNano("0.3");
const MIN_PROPOSER_BALANCE = toNano("1");
const MIN_SIGNER_BALANCE = toNano("0.3");

interface Op {
  id: string;
  wallet: WalletContractV4;
  secretKey: Buffer;
  pubkeyHex: string;
}

function client(cfg: E2eConfig): TonClient {
  return new TonClient({ endpoint: cfg.gram.endpoint, apiKey: cfg.gram.apiKey, timeout: 15000 });
}

async function toOp(id: string, mnemonic: string): Promise<Op> {
  const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  return {
    id,
    wallet: WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }),
    secretKey: kp.secretKey,
    pubkeyHex: kp.publicKey.toString("hex"),
  };
}

function operatorRef(op: Op): OperatorRef {
  // Rotation only needs the TON signer identity; VIZ/Solana pubkeys are unused here.
  return { id: op.id, vizPubkey: "", tonPubkey: op.pubkeyHex, solanaPubkey: "" };
}

function sender(c: TonClient, op: Op): Sender {
  return c.open(op.wallet).sender(op.secretKey);
}

/** Wait until `op`'s wallet seqno advances past `from` — i.e. its last message was accepted. */
async function waitSeqno(c: TonClient, op: Op, from: number): Promise<void> {
  const w = c.open(op.wallet);
  await pollUntil(async () => ((await w.getSeqno()) > from ? true : null), {
    timeoutMs: SEQNO_TIMEOUT_MS,
    intervalMs: POLL_MS,
    label: `${op.id} wallet seqno advances`,
  });
}

/** True once the order contract exists on-chain (a new_order landed). */
async function orderLanded(c: TonClient, addr: Address): Promise<void> {
  await pollUntil(async () => ((await c.getContractState(addr)).state === "active" ? true : null), {
    timeoutMs: ORDER_LANDS_TIMEOUT_MS,
    intervalMs: POLL_MS,
    label: "order lands on-chain",
  });
}

/** Current approvals count on an order (0 if not yet initialized). */
async function approvalsNum(c: TonClient, addr: Address): Promise<number> {
  const od = await c.open(Order.createFromAddress(addr)).getOrderData();
  return od.approvals_num ?? od.approvals.filter(Boolean).length;
}

/** Best-effort: scan an order's recent transactions for a compute-phase exit code 106. */
async function sawUnauthorizedSign(c: TonClient, addr: Address): Promise<boolean> {
  try {
    const txs = await c.getTransactions(addr, { limit: 8 });
    for (const tx of txs) {
      const d = tx.description;
      if (d.type === "generic" && d.computePhase.type === "vm" && d.computePhase.exitCode === 106) return true;
    }
  } catch {
    /* toncenter tx indexing lag — the approvals-invariant assertion is authoritative */
  }
  return false;
}

/** Poll until an order has executed (executed flag set, or contract destroyed itself post-execution). */
async function orderExecuted(c: TonClient, addr: Address): Promise<void> {
  await pollUntil(
    async () => {
      try {
        const od = await c.open(Order.createFromAddress(addr)).getOrderData();
        return od.executed ? true : null;
      } catch {
        // A destroyed order contract (state cleaned up post-execution) reads as gone.
        const st = await c.getContractState(addr);
        return st.state !== "active" ? true : null;
      }
    },
    { timeoutMs: EXECUTE_TIMEOUT_MS, intervalMs: POLL_MS, label: "order executes" },
  );
}

function openWithConfig(c: TonClient, addr: Address, cfg: MultisigConfig) {
  return c.open(new Multisig(addr, undefined, cfg));
}

/**
 * Drive the live rotation proof. Requires every configured operator's own TON
 * mnemonic (FED_OP<i>_GRAM_MNEMONIC). Throws on any failed assertion; logs a PASS
 * line on success.
 */
export async function proveRotationLive(
  cfg: E2eConfig,
  operators: Array<{ id: string; gramMnemonic: string }>,
): Promise<void> {
  const c = client(cfg);
  const multisigAddr = Address.parse(cfg.gram.multisigAddress);
  const ops = await Promise.all(operators.map((o) => toOp(o.id, o.gramMnemonic)));

  // Read the live signer set. Map each configured operator to its current index.
  const data = await c.open(Multisig.createFromAddress(multisigAddr)).getMultisigData();
  const threshold = Number(data.threshold);
  const current = ops
    .map((op) => ({ op, idx: data.signers.findIndex((s) => s.equals(op.wallet.address)) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  // Criterion 4 needs REAL transactions from: the proposer, threshold-1 approvers,
  // AND the dropped operator (which must be able to SEND the approve that gets
  // rejected on-chain). That's threshold+1 funded, distinct operators — one more
  // than criteria 1-3 need. Balance-check up front so a missing faucet top-up fails
  // with a clear message instead of a cryptic mid-ceremony wallet error.
  const withBal = await Promise.all(
    current.map(async (x) => ({ ...x, bal: await c.getBalance(x.op.wallet.address) })),
  );
  const detail = () =>
    withBal.map((x) => `${x.op.id}[${x.idx}]=${(Number(x.bal) / 1e9).toFixed(2)}TON`).join(", ");

  // Proposer: lowest-index signer with headroom for two new_orders.
  const proposerEntry = withBal.filter((x) => x.bal >= MIN_PROPOSER_BALANCE).sort((a, b) => a.idx - b.idx)[0];
  if (!proposerEntry) {
    throw new Error(
      `criterion 4 needs a proposer signer with ≥2.5 TON (two new_orders); none qualify. ` +
        `Fund a signer wallet via the faucet. Current balances: ${detail()}.`,
    );
  }
  // Remaining funded signers (excluding the proposer): the approver+droppable pool.
  const pool = withBal
    .filter((x) => x.op !== proposerEntry.op && x.bal >= MIN_SIGNER_BALANCE)
    .sort((a, b) => a.idx - b.idx);
  if (pool.length < threshold) {
    throw new Error(
      `criterion 4 needs ${threshold} more funded signers besides the proposer ` +
        `(${threshold - 1} approvers + 1 droppable, each ≥0.3 TON); only ${pool.length} qualify. ` +
        `Fund one more operator wallet via the faucet, then re-run. Current balances: ${detail()}.`,
    );
  }

  const proposer = proposerEntry.op;
  const proposerIdx = proposerEntry.idx;
  const dropped = pool[pool.length - 1]!.op; // highest-index funded — removed, yet able to send the rejected approve
  const approvers = pool.slice(0, threshold - 1); // [{op, idx}] with CURRENT signer index; distinct from `dropped`
  // New signer set = the whole current on-chain set minus the dropped operator
  // (may still include unfunded signers, which simply abstain).
  const newSet = current.filter((x) => x.op !== dropped).map((x) => operatorRef(x.op));
  console.log(
    `[fed-ton]   current ${threshold}-of-${data.signers.length}; proposer ${proposer.id}; dropping ${dropped.id}; ` +
      `new set ${threshold}-of-${newSet.length}; approvers ${approvers.map((x) => x.op.id).join(",")}`,
  );

  const liveCfg: MultisigConfig = {
    threshold,
    signers: data.signers,
    proposers: data.proposers,
    allowArbitrarySeqno: false,
  };
  // 48h order TTL (async approval window); local-clock skew is irrelevant at that scale.
  const expiration = Math.floor(Date.now() / 1000) + 48 * 3600;

  // ── Step A: rotate — proposer proposes the drop, retained set approves to threshold ──
  const rotationOrderAddr = await c.open(Multisig.createFromAddress(multisigAddr)).getOrderAddress(data.nextOrderSeqno);
  const rotationAction = buildUpdateAction(newSet, threshold);
  const proposerSeqno0 = await c.open(proposer.wallet).getSeqno();
  await openWithConfig(c, multisigAddr, liveCfg).sendNewOrder(
    sender(c, proposer),
    [rotationAction],
    expiration,
    NEW_ORDER_VALUE,
    proposerIdx,
    true,
  );
  console.log(`[fed-ton]   ${proposer.id} sent rotation new_order -> ${rotationOrderAddr.toString()}`);
  await waitSeqno(c, proposer, proposerSeqno0);
  await orderLanded(c, rotationOrderAddr);

  // The threshold-1 approvers approve from their OWN wallet at their CURRENT signer
  // index, one at a time (proposer already self-approved on init = 1/threshold).
  for (const { op, idx } of approvers) {
    const s0 = await c.open(op.wallet).getSeqno();
    await c.open(Order.createFromAddress(rotationOrderAddr)).sendApprove(sender(c, op), idx);
    console.log(`[fed-ton]   ${op.id} approved rotation (signer idx ${idx})`);
    await waitSeqno(c, op, s0);
  }

  // Confirm the multisig now carries the rotated signer set (dropped operator gone).
  const newSigners = current.filter((x) => x.op !== dropped).map((x) => x.op.wallet.address);
  await pollUntil(
    async () => {
      const d = await c.open(Multisig.createFromAddress(multisigAddr)).getMultisigData();
      return sameSignerSet(d.signers, newSigners) && !d.signers.some((s) => s.equals(dropped.wallet.address)) ? d : null;
    },
    { timeoutMs: EXECUTE_TIMEOUT_MS, intervalMs: POLL_MS, label: "multisig adopts rotated set" },
  );
  console.log(`[fed-ton]   ✓ rotation executed — ${dropped.id} removed from the signer set`);

  // ── Step B: prove the dropped operator can no longer authorize a NEW-set order ──
  const rotatedData = await c.open(Multisig.createFromAddress(multisigAddr)).getMultisigData();
  const rotatedCfg: MultisigConfig = {
    threshold,
    signers: rotatedData.signers,
    proposers: rotatedData.proposers,
    allowArbitrarySeqno: false,
  };
  // Index of each retained operator within the ROTATED signer set.
  const idxInNew = (op: Op) => rotatedData.signers.findIndex((s) => s.equals(op.wallet.address));

  // A fresh order under the rotated set (re-affirm the same set — idempotent, safe).
  const testOrderAddr = await c.open(Multisig.createFromAddress(multisigAddr)).getOrderAddress(rotatedData.nextOrderSeqno);
  const reaffirm = buildUpdateAction(newSet, threshold);
  const propIdxNew = idxInNew(proposer);
  const propSeqno1 = await c.open(proposer.wallet).getSeqno();
  await openWithConfig(c, multisigAddr, rotatedCfg).sendNewOrder(
    sender(c, proposer),
    [reaffirm],
    expiration,
    NEW_ORDER_VALUE,
    propIdxNew,
    true,
  );
  console.log(`[fed-ton]   ${proposer.id} opened test order under rotated set -> ${testOrderAddr.toString()}`);
  await waitSeqno(c, proposer, propSeqno1);
  await orderLanded(c, testOrderAddr);

  const beforeReject = await approvalsNum(c, testOrderAddr); // proposer's self-approve = 1
  // Dropped operator attempts to approve, claiming the proposer's slot (idx 0). Its
  // address is not signers[0], so the order rejects with err 106 unauthorized_sign.
  const dropSeqno = await c.open(dropped.wallet).getSeqno();
  await c.open(Order.createFromAddress(testOrderAddr)).sendApprove(sender(c, dropped), 0);
  console.log(`[fed-ton]   ${dropped.id} (dropped) attempted approve — must be rejected on-chain`);
  await waitSeqno(c, dropped, dropSeqno); // its wallet forwarded the message

  // Hold: the rejected approve must NOT increment the order's approval count.
  const rejectDeadline = Date.now() + REJECTION_HOLD_MS;
  while (Date.now() < rejectDeadline) {
    const n = await approvalsNum(c, testOrderAddr);
    if (n !== beforeReject) {
      throw new Error(`ROTATION HOLE: dropped ${dropped.id} approve COUNTED (${beforeReject}->${n})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const err106 = await sawUnauthorizedSign(c, testOrderAddr);
  console.log(
    `[fed-ton]   ✓ dropped ${dropped.id} approve did not count (held at ${beforeReject})` +
      (err106 ? " — on-chain exit 106 unauthorized_sign confirmed" : " (exit code not surfaced by toncenter; approvals-invariant is authoritative)"),
  );

  // ── Step C: the retained set still reaches threshold on that same order ──
  for (const op of approvers.map((x) => x.op)) {
    const idx = idxInNew(op);
    const s0 = await c.open(op.wallet).getSeqno();
    await c.open(Order.createFromAddress(testOrderAddr)).sendApprove(sender(c, op), idx);
    console.log(`[fed-ton]   ${op.id} approved test order (rotated idx ${idx})`);
    await waitSeqno(c, op, s0);
  }
  await orderExecuted(c, testOrderAddr);
  console.log(`[fed-ton]   ✓ retained ${threshold}-of-${newSet.length} set reached threshold and executed`);
}
