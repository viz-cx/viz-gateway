// Read-only inspection of the mainnet wVIZ Jetton minter: state, balance,
// get_jetton_data (total supply / mintable / admin) + decoded TEP-64 on-chain
// content (name / symbol / decimals / description / image). Pure get-methods,
// no stack, no broadcast.
// Env: GRAM_ENDPOINT | TON_ENDPOINT, GRAM_API_KEY | TON_API_KEY.
const { createHash } = require("node:crypto");
const { TonClient, Address, fromNano, Dictionary } = require("@ton/ton");

// TEP-64 snake/chunked string: the root cell starts with a 1-byte prefix
// (0x00 snake / 0x01 chunked) then UTF-8 bytes continue down the first ref.
function snakeToString(cell) {
  let out = Buffer.alloc(0);
  let cur = cell;
  let first = true;
  while (cur) {
    const sl = cur.beginParse();
    if (first) sl.loadUint(8); // drop prefix byte on the root cell only
    first = false;
    const nbytes = Math.floor(sl.remainingBits / 8);
    if (nbytes > 0) out = Buffer.concat([out, sl.loadBuffer(nbytes)]);
    cur = cur.refs.length > 0 ? cur.refs[0] : null;
  }
  return out.toString("utf8");
}

const sha256 = (k) => createHash("sha256").update(k).digest();

function decodeOnchainContent(contentCell) {
  const s = contentCell.beginParse();
  const prefix = s.loadUint(8); // 0x00 = on-chain
  if (prefix !== 0x00) return { _format: `off-chain/other (prefix 0x${prefix.toString(16)})` };
  const dict = s.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  const keys = ["name", "symbol", "decimals", "description", "image", "image_data"];
  const out = { _format: "on-chain (TEP-64)" };
  for (const k of keys) {
    const v = dict.get(sha256(k));
    if (v) out[k] = snakeToString(v);
  }
  return out;
}

(async () => {
  const endpoint = process.env.GRAM_ENDPOINT || process.env.TON_ENDPOINT;
  if (!endpoint) throw new Error("GRAM_ENDPOINT (or TON_ENDPOINT) required");
  const apiKey = process.env.GRAM_API_KEY || process.env.TON_API_KEY || undefined;
  const c = new TonClient({ endpoint, apiKey });
  const addr = Address.parse(
    process.env.MINTER || "EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ",
  );
  const state = await c.getContractState(addr);
  console.log("address    :", addr.toString());
  console.log("raw        :", addr.toRawString());
  console.log("state      :", state.state);
  console.log("balance    :", fromNano(state.balance), "TON");
  if (state.state !== "active") {
    console.log("(not active — not deployed or frozen)");
    return;
  }
  const r = await c.runMethod(addr, "get_jetton_data");
  const s = r.stack;
  console.log("totalSupply:", s.readBigNumber().toString(), "(base units / mVIZ)");
  console.log("mintable   :", s.readBigNumber().toString(), "(-1 = true)");
  const admin = s.readAddressOpt ? s.readAddressOpt() : s.readAddress();
  console.log("admin      :", admin ? admin.toString() : "addr_none");
  const contentCell = s.readCell();
  console.log("content    :", JSON.stringify(decodeOnchainContent(contentCell), null, 2));
})().catch((e) => console.log("ERR", e.message));
