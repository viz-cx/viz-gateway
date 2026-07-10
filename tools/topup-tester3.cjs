// One-off: manual refund from gateway pool tester4 -> tester3 to clear the e2e
// preflight (tester3 drained by stuck/unrefunded locks). Mirrors submitLock's
// transfer construction. Reads keys from .env.e2e via the shell (set -a).
// Uses ASYNC broadcast_transaction + balance poll: the synchronous variant blocks
// until block inclusion and the public RPC proxies 504 on that wait.
const viz = require("viz-js-lib");

const NODE = process.env.E2E_VIZ_NODE_URL;
const FROM = process.env.E2E_VIZ_GATEWAY_ACCOUNT; // tester4
// tester4 active authority is 2-of-3 (FED_OP1/2/3 pubkeys); sign with two of them.
const WIFS = [process.env.FED_OP1_WIF, process.env.FED_OP2_WIF].filter(Boolean);
const TO = process.env.E2E_VIZ_TEST_ACCOUNT; // tester3
const AMOUNT = process.env.TOPUP_AMOUNT || "50.000 VIZ";

function call(fn) {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));
}
function toMilli(bal) {
  const p = bal.replace(/\s*VIZ$/i, "").split(".");
  return BigInt(p[0] || "0") * 1000n + BigInt(((p[1] || "") + "000").slice(0, 3));
}
async function balance(acct) {
  const a = await call((cb) => viz.api.getAccounts([acct], cb));
  return a && a[0] ? toMilli(a[0].balance) : 0n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!NODE || !FROM || WIFS.length < 2 || !TO) throw new Error("missing env (NODE/FROM/2xWIF/TO)");
  viz.config.set("websocket", NODE);
  const before = await balance(TO);
  const want = before + toMilli(AMOUNT);

  const gp = await call((cb) => viz.api.getDynamicGlobalProperties(cb));
  const tx = {
    ref_block_num: gp.head_block_number & 0xffff,
    ref_block_prefix: Buffer.from(gp.head_block_id, "hex").readUInt32LE(4),
    expiration: new Date(Date.now() + 90_000).toISOString().slice(0, 19),
    operations: [["transfer", { from: FROM, to: TO, amount: AMOUNT, memo: "e2e topup (manual refund of stuck locks)" }]],
    extensions: [],
  };
  const signed = viz.auth.signTransaction(tx, WIFS);
  try {
    await call((cb) => viz.api.broadcastTransaction(signed, cb)); // async: returns before inclusion
    console.log("broadcast_transaction accepted (async)");
  } catch (e) {
    console.log(`broadcast returned error (may still land): ${String(e).slice(0, 80)}`);
  }
  // Poll for the credit — the async broadcast confirms nothing, the chain does.
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const now = await balance(TO);
    if (now >= want) {
      console.log(`topup OK: ${TO} ${before}->${now} mVIZ (wanted ${want})`);
      return;
    }
  }
  throw new Error(`topup NOT credited after 90s (balance still ${await balance(TO)} mVIZ, wanted ${want})`);
}

main().catch((e) => {
  console.error("topup FAILED:", e && e.message ? e.message : e);
  process.exit(1);
});
