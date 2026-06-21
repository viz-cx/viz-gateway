import { readFileSync, writeFileSync } from "node:fs";
import viz, { type Account, type BroadcastResult, type DynamicGlobalProperties } from "viz-js-lib";
import {
  buildProposal,
  buildActiveAuthority,
  authorityHash,
  parseOperators,
  serializeOperators,
  validateProposal,
  addPartial,
  type RotationProposal,
} from "@gateway/common";

function call<T>(exec: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => exec((err, res) => (err ? reject(err) : resolve(res))));
}

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const NODE_URL = process.env.VIZ_NODE_URL || "https://node.viz.cx";
const GATEWAY = process.env.GATEWAY_ACCOUNT || "viz-gateway";
const CHAIN_ID = process.env.ROTATION_CHAIN_ID || "viz-gateway";

async function readGatewayAccount(): Promise<Account> {
  const accts = await call<Account[]>((cb) => viz.api.getAccounts([GATEWAY], cb));
  const a = accts[0];
  if (!a) throw new Error(`gateway account '${GATEWAY}' not found on ${NODE_URL}`);
  return a;
}

async function freshTaPoS(): Promise<{ refBlockNum: number; refBlockPrefix: number; expiration: string }> {
  const gp = await call<DynamicGlobalProperties>((cb) => viz.api.getDynamicGlobalProperties(cb));
  return {
    refBlockNum: gp.head_block_number & 0xffff,
    refBlockPrefix: Buffer.from(gp.head_block_id, "hex").readUInt32LE(4),
    // VIZ caps expiration at 1h; use 55min to leave broadcast headroom.
    expiration: new Date(Date.now() + 55 * 60_000).toISOString().slice(0, 19),
  };
}

async function propose(): Promise<void> {
  const operatorsArg = arg("operators");
  const thresholdArg = arg("threshold");
  const wif = process.env.VIZ_SIGNING_WIF || "";
  const out = arg("out") || "rotation-proposal.json";
  if (!operatorsArg || !thresholdArg) throw new Error("propose needs --operators and --threshold");
  if (!wif) throw new Error("VIZ_SIGNING_WIF (your operator active key) is required to propose");

  const newOperators = parseOperators(operatorsArg);
  const newThreshold = Number.parseInt(thresholdArg, 10);
  buildActiveAuthority(newOperators, newThreshold); // validates threshold/dupes early

  const account = await readGatewayAccount();
  const currentActiveHash = authorityHash(account.active_authority);
  const taPoS = await freshTaPoS();

  const proposal = buildProposal({
    chainId: CHAIN_ID,
    account: GATEWAY,
    newOperators,
    newThreshold,
    memoKey: account.memo_key,
    jsonMetadata: account.json_metadata,
    currentActiveHash,
    taPoS,
  });

  // Sign with the proposer's own key (first partial). signTransaction appends.
  const signed = viz.auth.signTransaction(
    { ...proposal.vizTx, signatures: [] },
    [wif],
  );
  const firstSig = signed.signatures?.[signed.signatures.length - 1];
  if (!firstSig) throw new Error("signTransaction produced no signature");
  const withSig = addPartial(proposal, firstSig);

  writeFileSync(out, JSON.stringify(withSig, null, 2));
  console.log(`[propose] wrote ${out}`);
  console.log(`[propose] new set: ${serializeOperators(newOperators)} (threshold ${newThreshold})`);
  console.log(`[propose] expires ${withSig.vizTx.expiration}Z — collect ${newThreshold} partials and broadcast within the hour.`);
}

function coSign(): void {
  const file = process.argv[3];
  const wif = process.env.VIZ_SIGNING_WIF || "";
  if (!file) throw new Error("co-sign needs a proposal file path");
  if (!wif) throw new Error("VIZ_SIGNING_WIF (your operator active key) is required to co-sign");

  const proposal = JSON.parse(readFileSync(file, "utf8")) as RotationProposal;
  // Trust-critical: rebuild the op and reject anything not matching the claimed
  // set/threshold, wrong chainId, or expired. Network not required.
  validateProposal(proposal, { chainId: CHAIN_ID, nowMs: Date.now() });

  const signed = viz.auth.signTransaction({ ...proposal.vizTx, signatures: [] }, [wif]);
  const mySig = signed.signatures?.[signed.signatures.length - 1];
  if (!mySig) throw new Error("signTransaction produced no signature");
  const updated = addPartial(proposal, mySig);

  writeFileSync(file, JSON.stringify(updated, null, 2));
  console.log(`[co-sign] appended partial; ${updated.vizTx.signatures.length} collected (need ${updated.newThreshold}).`);
  if (updated.vizTx.signatures.length >= updated.newThreshold) {
    console.log("[co-sign] threshold reached — ready for `rotate broadcast viz`.");
  }
}

async function main(): Promise<void> {
  viz.config.set("websocket", NODE_URL);
  const sub = process.argv[2];
  const action = process.argv[3];
  if (sub === "propose") return propose();
  if (sub === "co-sign") return coSign();
  // broadcast added in a later task
  throw new Error(`unknown subcommand: ${sub} ${action ?? ""}`.trim());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
