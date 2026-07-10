const { TonClient, Address, Dictionary } = require("@ton/ton");
(async () => {
  const c = new TonClient({ endpoint: process.env.E2E_GRAM_ENDPOINT, apiKey: process.env.E2E_GRAM_API_KEY });
  const ms = Address.parse(process.env.MS || "EQBzysCTCDi2Y3ygBjFpOOX-WfYlTgmRV51hCVTklwbM_u7N");
  const r = await c.runMethod(ms, "get_multisig_data");
  const items = r.stack;
  const nextSeqno = items.readBigNumber();
  const threshold = items.readBigNumber();
  console.log("next_order_seqno:", nextSeqno.toString());
  console.log("threshold:", threshold.toString());
  // signers: try tuple-of-slices; fall back to cell dict.
  const addrs = [];
  const peek = items.pop();
  if (peek.type === "cell") {
    const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address(), peek.cell);
    for (const [, v] of dict) addrs.push(v.toString({ testOnly: true }));
  } else {
    console.log("signers stack item type:", peek.type);
  }
  console.log("signers (" + addrs.length + "):");
  addrs.forEach((a) => console.log("  ", a));
})().catch((e) => console.log("ERR", e.message));
