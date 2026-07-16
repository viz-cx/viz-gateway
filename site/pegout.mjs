// Pure, dependency-free builders + validators for the wVIZ bridge app.
// TON primitives (beginCell/Address) are INJECTED so this same module runs in the
// browser (CDN primitives) and in Node (require("@ton/ton")) — one source of truth,
// mirroring tools/e2e/ton.ts submitBurn. Must round-trip through parseJettonDeposit.

export function buildCommentCell(beginCell, text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

export function buildPegoutBody(
  { beginCell, Address },
  { amountBaseUnits, destinationOwner, responseAddress, forwardTonAmount, vizRecipient },
) {
  const comment = buildCommentCell(beginCell, vizRecipient);
  return beginCell()
    .storeUint(0x0f8a7ea5, 32) // TEP-74 transfer
    .storeUint(0n, 64) // query_id
    .storeCoins(amountBaseUnits)
    .storeAddress(Address.parse(destinationOwner)) // destination owner (multisig)
    .storeAddress(Address.parse(responseAddress)) // response destination (sender)
    .storeBit(false) // no custom payload
    .storeCoins(forwardTonAmount) // forward_ton_amount
    .storeBit(true) // forward_payload in ref
    .storeRef(comment)
    .endCell();
}

export function wvizToBaseUnits(input, decimals = 3) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid amount");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`max ${decimals} decimals`);
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  if (units <= 0n) throw new Error("amount must be positive");
  return units;
}

export function computePegInFee({ grossMilliViz, floorMilliViz, bps, activationSurchargeMilliViz, walletDeployed }) {
  const pct = (grossMilliViz * BigInt(bps)) / 10000n;
  const base = pct > floorMilliViz ? pct : floorMilliViz;
  const activation = walletDeployed ? 0n : activationSurchargeMilliViz;
  return { base, activation, total: base + activation };
}

export function isValidVizAccount(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 2 || n.length > 25) return false;
  if (n.includes("--") || n.endsWith("-")) return false;
  return /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(n);
}
