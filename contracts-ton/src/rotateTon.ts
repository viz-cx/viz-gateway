import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Address, toNano } from "@ton/core";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import {
  validateProposal,
  mergeState,
  type RotationProposal,
  type RotationState,
} from "@gateway/common";
import { Multisig } from "./wrappers/Multisig";
import { Order } from "./wrappers/Order";
import {
  buildUpdateAction,
  tonSignerAddress,
  sameSignerSet,
  validateTonOrder,
} from "./tonRotation";

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ENDPOINT = process.env.TON_ENDPOINT || "https://toncenter.com/api/v2/jsonRPC";
const API_KEY = process.env.TON_API_KEY || "";
const MULTISIG = process.env.TON_MULTISIG_ADDRESS || "";
const CHAIN_ID = process.env.ROTATION_CHAIN_ID || "viz-gateway";
const MNEMONIC = process.env.TON_SIGNER_MNEMONIC || "";
// Orders allow a long expiration (unlike VIZ's 1h); default 48h for async approval.
const ORDER_TTL_SEC = Number.parseInt(process.env.TON_ORDER_TTL_SEC || "172800", 10);

function client(): TonClient {
  return new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY || undefined, timeout: 15000 });
}

function readProposal(file: string): RotationProposal {
  return JSON.parse(readFileSync(file, "utf8")) as RotationProposal;
}

function readState(file: string): RotationState {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as RotationState;
  return { proposalFile: "", vizDone: false, tonOrderAddress: "", tonDone: false };
}

async function signerWallet(): Promise<{ wallet: WalletContractV4; secretKey: Buffer }> {
  if (!MNEMONIC) throw new Error("TON_SIGNER_MNEMONIC (your operator TON wallet) is required");
  const kp = await mnemonicToPrivateKey(MNEMONIC.trim().split(/\s+/));
  return { wallet: WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }), secretKey: kp.secretKey };
}

async function submitTon(): Promise<void> {
  const file = process.argv[3] || "rotation-proposal.json";
  const stateFile = arg("state") || "rotation-state.json";
  const apply = process.env.APPLY === "1";
  if (!MULTISIG) throw new Error("TON_MULTISIG_ADDRESS is required");

  const proposal = readProposal(file);
  validateProposal(proposal, { chainId: CHAIN_ID, nowMs: Date.now() }); // chainId + version + (VIZ) shape

  const c = client();
  // Use createFromAddress for the initial data fetch (no configuration needed for getters).
  const multisigAddr = Address.parse(MULTISIG);
  const dataMultisig = c.open(Multisig.createFromAddress(multisigAddr));
  const data = await dataMultisig.getMultisigData(); // { nextOrderSeqno, threshold, signers, proposers }

  const { wallet, secretKey } = await signerWallet();
  const myIdx = data.signers.findIndex((s) => s.equals(wallet.address));
  if (myIdx < 0) {
    throw new Error(`your wallet ${wallet.address.toString()} is not a current multisig signer`);
  }

  const action = buildUpdateAction(proposal.newOperators, proposal.newThreshold);
  const newSigners = proposal.newOperators.map((o) => tonSignerAddress(o.tonPubkey));
  console.log(`[submit-ton] update to ${proposal.newThreshold}-of-${newSigners.length}; proposer signer index ${myIdx}`);
  console.log(`[submit-ton] new signers:\n  ${newSigners.map((a) => a.toString()).join("\n  ")}`);

  const expiration = Math.floor(Date.now() / 1000) + ORDER_TTL_SEC;
  const orderAddr = await dataMultisig.getOrderAddress(data.nextOrderSeqno);

  if (!apply) {
    console.log(`[submit-ton] order seqno ${data.nextOrderSeqno}, address ${orderAddr.toString()}`);
    console.log("[submit-ton] DRY-RUN. Set APPLY=1 to send the new_order.");
    return;
  }

  // sendNewOrder requires configuration to be set for the auto-detect signer/proposer path.
  // Re-open with a synthetic configuration built from on-chain data so validation passes.
  const multisigWithConfig = new Multisig(multisigAddr, undefined, {
    threshold: Number(data.threshold),
    signers: data.signers,
    proposers: data.proposers,
    allowArbitrarySeqno: false,
  });
  const openedMultisig = c.open(multisigWithConfig);

  const opened = c.open(wallet);
  const sender = opened.sender(secretKey);
  // isSigner=true auto-detected from configuration + sender.address; approve on init.
  await openedMultisig.sendNewOrder(sender, [action], expiration, toNano("1"), myIdx, true);

  const state = mergeState(readState(stateFile), {
    proposalFile: file,
    tonOrderAddress: orderAddr.toString(),
    tonDone: false,
  });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`[submit-ton] sent. Order address: ${orderAddr.toString()}`);
  console.log(`[submit-ton] share that address; each other signer runs: rotate:ton approve-ton ${orderAddr.toString()}`);
}

async function approveTon(): Promise<void> {
  const orderArg = process.argv[3];
  const fileFromFlag = arg("proposal");
  const apply = process.env.APPLY === "1";
  if (!orderArg) throw new Error("approve-ton needs the order address (rotate:ton approve-ton <order-address>)");

  // Proposal is the spec each approver re-validates against. Default to the
  // standard filename; allow --proposal to override.
  const proposal = readProposal(fileFromFlag || "rotation-proposal.json");
  validateProposal(proposal, { chainId: CHAIN_ID, nowMs: Date.now(), skipExpiry: true });

  const c = client();
  const order = c.open(Order.createFromAddress(Address.parse(orderArg)));
  const od = await order.getOrderData();
  if (od.executed) {
    console.log("[approve-ton] order already executed — nothing to do.");
    return;
  }
  if (!od.order) throw new Error("order not initialized yet (proposer must submit-ton first)");

  // Trust-critical: the on-chain order's action must match the proposal exactly.
  validateTonOrder(od.order, proposal);

  const { wallet, secretKey } = await signerWallet();
  const myIdx = od.signers.findIndex((s) => s.equals(wallet.address));
  if (myIdx < 0) throw new Error(`your wallet ${wallet.address.toString()} is not a signer on this order`);
  if (od.approvals[myIdx]) {
    console.log("[approve-ton] you already approved this order.");
    return;
  }

  const approved = od.approvals.filter(Boolean).length;
  if (od.expiration_date !== null && od.expiration_date < BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error(`[approve-ton] order expired at ${new Date(Number(od.expiration_date) * 1000).toISOString()}`);
  }
  console.log(`[approve-ton] order validated; ${approved}/${od.threshold ?? "?"} approved; your signer index ${myIdx}`);
  if (!apply) {
    console.log("[approve-ton] DRY-RUN. Set APPLY=1 to send your on-chain approve.");
    return;
  }

  const sender = c.open(wallet).sender(secretKey);
  await order.sendApprove(sender, myIdx);
  console.log("[approve-ton] approve sent. At threshold the order auto-executes and the multisig params update.");
}

async function status(): Promise<void> {
  const file = arg("proposal") || "rotation-proposal.json";
  const stateFile = arg("state") || "rotation-state.json";
  if (!MULTISIG) throw new Error("TON_MULTISIG_ADDRESS is required");

  const proposal = readProposal(file);
  const c = client();
  const multisig = c.open(Multisig.createFromAddress(Address.parse(MULTISIG)));
  const data = await multisig.getMultisigData();

  const expectedSigners = proposal.newOperators.map((o) => tonSignerAddress(o.tonPubkey));
  const tonDone = sameSignerSet(data.signers, expectedSigners) && Number(data.threshold) === proposal.newThreshold;

  const st = readState(stateFile);
  console.log(`[status] VIZ done:  ${st.vizDone}`);
  console.log(`[status] TON multisig now: ${data.threshold}-of-${data.signers.length}`);
  console.log(`[status] TON matches new set: ${tonDone}`);

  // Show order progress if we have an address checkpointed.
  if (st.tonOrderAddress) {
    try {
      const order = c.open(Order.createFromAddress(Address.parse(st.tonOrderAddress)));
      const od = await order.getOrderData();
      const approved = od.approvals.filter(Boolean).length;
      console.log(`[status] order ${st.tonOrderAddress}: executed=${od.executed} approvals=${approved}/${od.threshold ?? "?"}`);
    } catch {
      console.log(`[status] order ${st.tonOrderAddress}: not readable (may have executed + been cleaned up).`);
    }
  }

  if (tonDone && !st.tonDone) {
    writeFileSync(stateFile, JSON.stringify(mergeState(st, { tonDone: true }), null, 2));
    console.log("[status] recorded tonDone=true. Rotation complete on both chains once vizDone is also true.");
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "submit-ton") return submitTon();
  if (sub === "approve-ton") return approveTon();
  if (sub === "status") return status();
  throw new Error(`unknown subcommand: ${sub ?? ""}`.trim());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
