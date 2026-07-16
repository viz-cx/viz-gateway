// Multisig gas recycler — STEP 1 (proposer / any live operator).
//
// Over-funded peg-in orders leave their surplus in the multisig contract (the Order
// contract returns leftover value to the multisig on execution, NOT to the proposer),
// so the multisig balance grows while operator wallets — which pay per-approval gas
// and attach the order value — slowly drain. This tool recycles that trapped balance
// back OUT to the operator wallets via a normal 2-of-3 order.
//
// It builds ONE order containing one "send TON" action per recipient, proposes it with
// approve_on_init (proposer's approval counts immediately → 1/threshold), and prints the
// Order address. A second, independent operator then reaches threshold by running the
// EXISTING tools/multisig-proof-approve.cjs against that Order address — that script
// decodes and prints every action first, so the approver confirms exactly what they sign.
//
// The multisig can only move its own balance through an approved order like this; it can
// NEVER sponsor the per-approval external messages (each `approve` is signed by and paid
// from the operator's own wallet by protocol design). So this recycles the attach-value
// half of the drain, not the approval-gas half.
//
// Env:
//   GRAM_ENDPOINT | TON_ENDPOINT      — TON node
//   GRAM_API_KEY  | TON_API_KEY       — optional toncenter key
//   DEPLOYER_MNEMONIC | GRAM_SIGNER_MNEMONIC | MNEMONIC — proposer's 24 words
//   MULTISIG_ADDRESS                  — default = mainnet 2-of-3
//   SWEEP_TO                          — comma-separated recipient addresses (the operator wallets)
//   SWEEP_AMOUNT                      — TON per recipient (e.g. "1.0"); same for all
//   RESERVE                           — TON to leave in the multisig as a floor (default 0.5)
//   ORDER_VALUE                       — TON attached to fund the order (default 0.1)
// SEND=1 to broadcast.
const { TonClient, Address, WalletContractV4, WalletContractV5R1, toNano, fromNano, internal, SendMode } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");
const { Multisig } = require("../contracts/ton/dist/wrappers/Multisig.js");

const DEFAULT_MS = "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const endpoint = process.env.GRAM_ENDPOINT || process.env.TON_ENDPOINT;
  if (!endpoint) throw new Error("GRAM_ENDPOINT (or TON_ENDPOINT) required");
  const mnemonic = process.env.DEPLOYER_MNEMONIC || process.env.GRAM_SIGNER_MNEMONIC || process.env.MNEMONIC;
  if (!mnemonic) throw new Error("DEPLOYER_MNEMONIC (or GRAM_SIGNER_MNEMONIC/MNEMONIC) — proposer's 24 words — required");
  const toRaw = process.env.SWEEP_TO;
  if (!toRaw) throw new Error("SWEEP_TO required (comma-separated recipient operator wallet addresses)");
  const perAmount = toNano(process.env.SWEEP_AMOUNT || "0");
  if (perAmount <= 0n) throw new Error("SWEEP_AMOUNT required (TON per recipient, e.g. \"1.0\")");
  const reserve = toNano(process.env.RESERVE || "0.5");
  const orderValue = toNano(process.env.ORDER_VALUE || "0.1");

  const apiKey = process.env.GRAM_API_KEY || process.env.TON_API_KEY || undefined;
  const client = new TonClient({ endpoint, apiKey, timeout: 30000 });
  const multisigAddr = Address.parse(process.env.MULTISIG_ADDRESS || DEFAULT_MS);

  const recipients = toRaw.split(",").map((s) => Address.parse(s.trim()));
  const total = perAmount * BigInt(recipients.length);

  // Balance / safety floor check — never sweep below RESERVE.
  const balance = (await client.getBalance(multisigAddr));
  if (balance - total < reserve) {
    throw new Error(
      `refusing to sweep: balance ${fromNano(balance)} TON - payout ${fromNano(total)} TON ` +
        `= ${fromNano(balance - total)} TON would fall below RESERVE ${fromNano(reserve)} TON`,
    );
  }

  const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const candidates = [
    WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }),
    WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey }),
  ];

  const ms = client.open(Multisig.createFromAddress(multisigAddr));
  const md = await ms.getMultisigData();

  let wallet, myIdx = -1, flavour = "";
  for (const [j, c] of candidates.entries()) {
    const i = md.signers.findIndex((s) => s.equals(c.address));
    if (i >= 0) { wallet = c; myIdx = i; flavour = j === 0 ? "v4" : "v5r1"; break; }
  }
  if (!wallet) throw new Error("proposer wallet not found in multisig signer set (v4/v5r1 both tried)");

  const orderSeqno = md.nextOrderSeqno;
  const orderAddr = await ms.getOrderAddress(orderSeqno);

  console.log("multisig     :", multisigAddr.toString());
  console.log("balance      :", fromNano(balance), "TON  (reserve floor", fromNano(reserve), "TON)");
  console.log("proposer     :", wallet.address.toString(), `(op idx ${myIdx}, ${flavour})`);
  console.log("threshold    :", md.threshold.toString(), "of", md.signers.length);
  console.log("order seqno  :", orderSeqno.toString());
  console.log("ORDER ADDR   :", orderAddr.toString(), "<-- give this to a 2nd operator");
  console.log("payout       :", fromNano(perAmount), "TON x", recipients.length, "=", fromNano(total), "TON");
  recipients.forEach((r, i) => console.log(`  [${i}] -> ${r.toString()}`));
  console.log("post-sweep   :", fromNano(balance - total), "TON left in multisig");

  if (process.env.SEND !== "1") {
    console.log("\nDRY-RUN (set SEND=1 to broadcast the new_order). Recipients + amounts above are what a 2nd operator will see and approve.");
    return;
  }

  const actions = recipients.map((r) => ({
    type: "transfer",
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    message: internal({ to: r, value: perAmount, bounce: false }),
  }));
  const withConfig = new Multisig(multisigAddr, undefined, {
    threshold: Number(md.threshold),
    signers: md.signers,
    proposers: md.proposers,
    allowArbitrarySeqno: false,
  });
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  const sender = client.open(wallet).sender(kp.secretKey);
  await client.open(withConfig).sendNewOrder(sender, actions, expiration, orderValue, myIdx, true);
  console.log("\nnew_order sent. Polling for the order to appear on-chain...");

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if ((await client.getContractState(orderAddr)).state === "active") {
      console.log("ORDER LIVE :", orderAddr.toString(), `— proposer approved (1/${md.threshold}).`);
      console.log("\nNEXT: a 2nd operator runs tools/multisig-proof-approve.cjs with ORDER_ADDRESS =", orderAddr.toString());
      return;
    }
    await sleep(4000);
  }
  console.log("order did not appear within 120s — check explorer:", orderAddr.toString());
})().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
