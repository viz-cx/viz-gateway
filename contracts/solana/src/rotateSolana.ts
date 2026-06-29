import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMultisig,
  getMint,
  getMultisig,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  validateProposal,
  mergeState,
  type RotationProposal,
  type RotationState,
  type SolanaRotationProposal,
} from "@gateway/common";
import { loadSolanaRotationConfig } from "./config";
import {
  handoffMessageB64,
  signHandoff,
  buildSignedHandoffTx,
  validateHandoffProposal,
} from "./solanaRotation";

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadSolanaRotationConfig();

function readMaster(file: string): RotationProposal {
  return JSON.parse(readFileSync(file, "utf8")) as RotationProposal;
}
function readSolana(file: string): SolanaRotationProposal {
  return JSON.parse(readFileSync(file, "utf8")) as SolanaRotationProposal;
}
function readState(file: string): RotationState {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as RotationState;
  return {
    proposalFile: "",
    vizDone: false,
    tonOrderAddress: "",
    tonDone: false,
    solanaNewMultisig: "",
    solanaDone: false,
  };
}

/** Read an SPL multisig's members (base58, only the first `n`) + threshold. */
async function readMultisigMembers(
  conn: Connection,
  addr: PublicKey,
): Promise<{ members: string[]; threshold: number }> {
  const ms = await getMultisig(conn, addr, "confirmed", TOKEN_2022_PROGRAM_ID);
  const all = [
    ms.signer1, ms.signer2, ms.signer3, ms.signer4,
    ms.signer5, ms.signer6, ms.signer7, ms.signer8,
    ms.signer9, ms.signer10, ms.signer11,
  ];
  const members = all.slice(0, ms.n).map((p) => p.toBase58());
  return { members, threshold: ms.m };
}

async function proposeSolana(): Promise<void> {
  const masterFile = arg("master") || "rotation-proposal.json";
  const out = arg("out") || "rotation-solana.json";
  if (!cfg.oldMultisig || !cfg.mint || !cfg.nonceAccount) {
    throw new Error("SOLANA_MULTISIG, SOLANA_WVIZ_MINT, SOLANA_ROTATION_NONCE_ACCOUNT are required");
  }
  if (!cfg.submitterSecret) throw new Error("SOLANA_SUBMITTER_SECRET (proposer/submitter) is required");

  const master = readMaster(masterFile);
  validateProposal(master, { chainId: cfg.chainId, nowMs: Date.now(), skipExpiry: true });
  const newSolKeys = master.newOperators.map((o) => o.solanaPubkey);
  if (newSolKeys.some((k) => !k)) throw new Error("master proposal has an operator without solanaPubkey");
  if (new Set(newSolKeys).size !== newSolKeys.length) throw new Error("duplicate solanaPubkey in new set");

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const submitter = Keypair.fromSecretKey(cfg.submitterSecret);

  // Phase A: create the new SPL multisig (permissionless).
  console.log(`[propose-solana] creating new ${master.newThreshold}-of-${newSolKeys.length} multisig...`);
  if (!cfg.apply) {
    console.log(`[propose-solana] new members:\n  ${newSolKeys.join("\n  ")}`);
    console.log("[propose-solana] DRY-RUN. Set APPLY=1 to create the multisig + build the proposal.");
    return;
  }
  const newMultisig = await createMultisig(
    conn,
    submitter,
    newSolKeys.map((k) => new PublicKey(k)),
    master.newThreshold,
    Keypair.generate(),
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`[propose-solana] new multisig: ${newMultisig.toBase58()}`);

  // Pin the current members (sorted) + the rotation nonce value.
  const current = await readMultisigMembers(conn, new PublicKey(cfg.oldMultisig));
  const nonce = await conn.getNonce(new PublicKey(cfg.nonceAccount), "confirmed");
  if (!nonce) throw new Error(`rotation nonce account ${cfg.nonceAccount} not found/initialized`);

  const proposal: SolanaRotationProposal = {
    version: 1,
    chainId: cfg.chainId,
    oldMultisig: cfg.oldMultisig,
    newMultisig: newMultisig.toBase58(),
    mint: cfg.mint,
    nonceAccount: cfg.nonceAccount,
    nonceValue: nonce.nonce,
    feePayer: submitter.publicKey.toBase58(),
    signers: [...current.members].sort(),
    messageB64: "",
    signatures: [],
  };
  proposal.messageB64 = handoffMessageB64(proposal);

  // Proposer co-signs first if their member key is configured.
  if (cfg.signerSecret) {
    const member = Keypair.fromSecretKey(cfg.signerSecret).publicKey.toBase58();
    if (proposal.signers.includes(member)) {
      proposal.signatures.push(signHandoff(proposal, cfg.signerSecret));
    }
  }

  writeFileSync(out, JSON.stringify(proposal, null, 2));
  console.log(`[propose-solana] wrote ${out} (${proposal.signatures.length} partial(s); need ${master.newThreshold})`);
  console.log(`[propose-solana] share ${out}; each current operator runs: rotate:solana co-sign-solana ${out}`);
}

async function coSignSolana(): Promise<void> {
  const file = process.argv[3] || "rotation-solana.json";
  const masterFile = arg("master") || "rotation-proposal.json";
  if (!cfg.signerSecret) throw new Error("SOLANA_SIGNER_SECRET (your member key) is required to co-sign");

  const proposal = readSolana(file);
  const master = readMaster(masterFile);
  validateProposal(master, { chainId: cfg.chainId, nowMs: Date.now(), skipExpiry: true });

  // Trust-critical: fetch the on-chain new multisig + validate it matches the master set.
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const onchain = await readMultisigMembers(conn, new PublicKey(proposal.newMultisig));
  validateHandoffProposal(proposal, master, onchain);

  const member = Keypair.fromSecretKey(cfg.signerSecret).publicKey.toBase58();
  const sig = signHandoff(proposal, cfg.signerSecret);
  if (!proposal.signatures.some((s) => s.startsWith(`${member}:`))) {
    proposal.signatures.push(sig);
  }
  writeFileSync(file, JSON.stringify(proposal, null, 2));
  console.log(`[co-sign-solana] appended partial; ${proposal.signatures.length} collected (need ${master.newThreshold}).`);
  if (proposal.signatures.length >= master.newThreshold) {
    console.log("[co-sign-solana] threshold reached — ready for `rotate:solana broadcast-solana`.");
  }
}

async function broadcastSolana(): Promise<void> {
  const file = process.argv[3] || "rotation-solana.json";
  const masterFile = arg("master") || "rotation-proposal.json";
  const stateFile = arg("state") || "rotation-state.json";
  if (!cfg.submitterSecret) throw new Error("SOLANA_SUBMITTER_SECRET is required to broadcast");

  const proposal = readSolana(file);
  const master = readMaster(masterFile);
  validateProposal(master, { chainId: cfg.chainId, nowMs: Date.now(), skipExpiry: true });
  if (proposal.signatures.length < master.newThreshold) {
    throw new Error(`only ${proposal.signatures.length}/${master.newThreshold} partials collected`);
  }

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  // Re-validate new multisig membership against chain.
  const onchain = await readMultisigMembers(conn, new PublicKey(proposal.newMultisig));
  validateHandoffProposal(proposal, master, onchain);

  // Anti-rollback: the mint's live authorities must still equal the old multisig.
  const mintInfo = await getMint(conn, new PublicKey(proposal.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const liveMint = mintInfo.mintAuthority?.toBase58() ?? "";
  const liveFreeze = mintInfo.freezeAuthority?.toBase58() ?? "";
  if (liveMint !== proposal.oldMultisig || liveFreeze !== proposal.oldMultisig) {
    throw new Error(
      `live mint/freeze authority (${liveMint}/${liveFreeze}) != old multisig ${proposal.oldMultisig} — another rotation may have landed`,
    );
  }

  console.log(`[broadcast-solana] handoff ${proposal.oldMultisig} -> ${proposal.newMultisig} (${master.newThreshold}-of-${master.newOperators.length})`);
  if (!cfg.apply) {
    console.log("[broadcast-solana] DRY-RUN. Set APPLY=1 to broadcast the handoff.");
    return;
  }

  const raw = buildSignedHandoffTx(proposal, proposal.signatures, cfg.submitterSecret);
  const minContextSlot = await conn.getSlot("confirmed");
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
  await conn.confirmTransaction(
    {
      signature: sig,
      nonceAccountPubkey: new PublicKey(proposal.nonceAccount),
      nonceValue: proposal.nonceValue,
      minContextSlot,
    },
    "confirmed",
  );
  console.log(`[broadcast-solana] handoff broadcast: ${sig}`);

  const state = mergeState(readState(stateFile), {
    proposalFile: masterFile,
    solanaNewMultisig: proposal.newMultisig,
    solanaDone: true,
  });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`[broadcast-solana] wrote ${stateFile}.`);
  console.log(`[broadcast-solana] ACTION REQUIRED: set SOLANA_MULTISIG=${proposal.newMultisig} and restart the gateway.`);
}

async function status(): Promise<void> {
  const masterFile = arg("master") || "rotation-proposal.json";
  const stateFile = arg("state") || "rotation-state.json";
  if (!cfg.mint) throw new Error("SOLANA_WVIZ_MINT is required");
  const master = readMaster(masterFile);
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const mintInfo = await getMint(conn, new PublicKey(cfg.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const liveMint = mintInfo.mintAuthority?.toBase58() ?? "";

  const st = readState(stateFile);
  const expectedNew = st.solanaNewMultisig;
  const solanaDone = !!expectedNew && liveMint === expectedNew;
  console.log(`[status] mint authority now: ${liveMint}`);
  console.log(`[status] expected new multisig: ${expectedNew || "(unknown — broadcast-solana not run)"}`);
  console.log(`[status] solana matches new set: ${solanaDone}`);

  if (solanaDone && !st.solanaDone) {
    writeFileSync(stateFile, JSON.stringify(mergeState(st, { solanaDone: true }), null, 2));
    console.log("[status] recorded solanaDone=true.");
  }

  if (expectedNew) {
    try {
      const live = await readMultisigMembers(conn, new PublicKey(expectedNew));
      const expected = master.newOperators.map((o) => o.solanaPubkey).sort();
      const actual = [...live.members].sort();
      const memberMatch = expected.length === actual.length && expected.every((v, i) => v === actual[i]);
      console.log(`[status] new multisig members match master set: ${memberMatch}`);
      console.log(`[status] new multisig threshold: ${live.threshold} (expected ${master.newThreshold})`);
    } catch (e) {
      console.log(`[status] could not read new multisig (not yet created?): ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "propose-solana") return proposeSolana();
  if (sub === "co-sign-solana") return coSignSolana();
  if (sub === "broadcast-solana") return broadcastSolana();
  if (sub === "status") return status();
  throw new Error(`unknown subcommand: ${sub ?? ""}`.trim());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
