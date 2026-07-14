// Read-only inspection of the mainnet 2-of-3 multisig: balance + get_multisig_data.
const { TonClient, Address, Dictionary, fromNano } = require("@ton/ton");
(async () => {
  const c = new TonClient({ endpoint: process.env.TON_ENDPOINT, apiKey: process.env.TON_API_KEY || undefined });
  const ms = Address.parse(process.env.MS || "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0");
  const state = await c.getContractState(ms);
  console.log("address   :", ms.toString());
  console.log("state     :", state.state);
  console.log("balance   :", fromNano(state.balance), "TON");
  if (state.state !== "active") { console.log("(not active — not deployed or frozen)"); return; }
  const r = await c.runMethod(ms, "get_multisig_data");
  const items = r.stack;
  console.log("next_seqno:", items.readBigNumber().toString());
  console.log("threshold :", items.readBigNumber().toString());
  const printAddrs = (label) => {
    const cell = items.readCellOpt();
    const arr = [];
    if (cell) {
      const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address(), cell);
      for (const [, v] of dict) arr.push(v.toString());
    }
    console.log(`${label} (${arr.length}):`);
    arr.forEach((a) => console.log("  ", a));
    return arr;
  };
  printAddrs("signers");
  printAddrs("proposers");
})().catch((e) => console.log("ERR", e.message));
