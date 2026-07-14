// Multisig liveness proof — STEP 1 (proposer / op-1).
//
// Submits a benign order to the mainnet 2-of-3 multisig: "send PROOF_AMOUNT TON
// to PROOF_TO" (defaults to op-1, a signer — funds stay in the family). The
// proposer's own approval is counted on init (approve_on_init), so this lands
// the order at 1/2. A second, independent operator then runs
// multisig-proof-approve.cjs from their OWN box to reach 2/2 → execute.
//
// This proves the full propose→approve→execute pipeline WITHOUT touching the
// wVIZ minter, so we can safely gate the one-way set-minter-admin handoff on it.
//
// Env: TON_ENDPOINT, TON_API_KEY, DEPLOYER_MNEMONIC (op-1, 24 words),
//      MULTISIG_ADDRESS (default = mainnet), PROOF_TO (default op-1),
//      PROOF_AMOUNT (default 0.02), ORDER_VALUE (default 0.1).
const { TonClient, Address, WalletContractV4, WalletContractV5R1, toNano, fromNano, internal, SendMode } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");
const { Multisig } = require("../contracts/ton/dist/wrappers/Multisig.js");

const DEFAULT_MS = "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const endpoint = process.env.TON_ENDPOINT;
  if (!endpoint) throw new Error("TON_ENDPOINT required");
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error("DEPLOYER_MNEMONIC (op-1, 24 words) required");
  const client = new TonClient({ endpoint, apiKey: process.env.TON_API_KEY || undefined, timeout: 30000 });
  const multisigAddr = Address.parse(process.env.MULTISIG_ADDRESS || DEFAULT_MS);

  const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const pk = kp.publicKey;
  const candidates = [
    WalletContractV4.create({ workchain: 0, publicKey: pk }),
    WalletContractV5R1.create({ workchain: 0, publicKey: pk }),
  ];

  const ms = client.open(Multisig.createFromAddress(multisigAddr));
  const md = await ms.getMultisigData();

  let wallet, myIdx = -1, flavour = "";
  for (const [j, c] of candidates.entries()) {
    const i = md.signers.findIndex((s) => s.equals(c.address));
    if (i >= 0) { wallet = c; myIdx = i; flavour = j === 0 ? "v4" : "v5r1"; break; }
  }
  if (!wallet) throw new Error("proposer wallet not found in multisig signer set (v4/v5r1 both tried)");

  const recipient = Address.parse(process.env.PROOF_TO || wallet.address.toString());
  const amount = toNano(process.env.PROOF_AMOUNT || "0.02");
  const orderValue = toNano(process.env.ORDER_VALUE || "0.1");
  const orderSeqno = md.nextOrderSeqno;
  const orderAddr = await ms.getOrderAddress(orderSeqno);

  console.log("multisig    :", multisigAddr.toString());
  console.log("proposer    :", wallet.address.toString(), `(op idx ${myIdx}, ${flavour})`);
  console.log("threshold   :", md.threshold.toString(), "of", md.signers.length);
  console.log("order seqno :", orderSeqno.toString());
  console.log("ORDER ADDR  :", orderAddr.toString(), "<-- give this to op-2");
  console.log("action      : send", fromNano(amount), "TON ->", recipient.toString());

  if (process.env.SEND !== "1") {
    console.log("\nDRY-RUN (set SEND=1 to broadcast the new_order from op-1).");
    return;
  }

  const transfer = {
    type: "transfer",
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    message: internal({ to: recipient, value: amount, bounce: false }),
  };
  const withConfig = new Multisig(multisigAddr, undefined, {
    threshold: Number(md.threshold),
    signers: md.signers,
    proposers: md.proposers,
    allowArbitrarySeqno: false,
  });
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  const sender = client.open(wallet).sender(kp.secretKey);
  await client.open(withConfig).sendNewOrder(sender, [transfer], expiration, orderValue, myIdx, true);
  console.log("\nnew_order sent from op-1. Polling for the order to appear on-chain...");

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if ((await client.getContractState(orderAddr)).state === "active") {
      console.log("ORDER LIVE :", orderAddr.toString(), "— op-1 approved (1/2).");
      console.log("\nNEXT: op-2 runs multisig-proof-approve.cjs with ORDER_ADDRESS =", orderAddr.toString());
      return;
    }
    await sleep(4000);
  }
  console.log("order did not appear within 120s — check explorer:", orderAddr.toString());
})().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
