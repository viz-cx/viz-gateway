// Devnet counterpart of tools/solana-devnet-proof-all.sh — pure Node, no
// solana CLI / Rust / Anchor needed:
//   - gateway_deposit is already deployed on devnet (pinned program ID), so the
//     peg-out proof skips its deploy step;
//   - keygen, faucet funding, and the durable nonce account are done here via
//     @solana/web3.js instead of the solana CLI.
//
// State (keys + deployed mint/multisig addresses) persists under PROOF_DIR
// (default ~/.viz-solana-devnet-proof) so reruns reuse faucet funds and the
// deployed mint instead of burning rate-limited airdrops.
//
//   node tools/solana-devnet-run.cjs              # both proofs
//   PROOF=pegin  node tools/solana-devnet-run.cjs
//   PROOF=pegout node tools/solana-devnet-run.cjs
//
// If the devnet faucet rate-limits, it prints the pubkeys to fund manually at
// https://faucet.solana.com and exits; rerun after funding.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROOF = process.env.PROOF || "both"; // both | pegin | pegout
const DIR = process.env.PROOF_DIR || path.join(require("node:os").homedir(), ".viz-solana-devnet-proof");
const REPO = path.resolve(__dirname, "..");
const STATE = path.join(DIR, "state.json");
const MIN_BALANCE = 0.05 * LAMPORTS_PER_SOL; // a full run spends well under this

const log = (m) => console.log(`[devnet-run] ${m}`);

function keypair(name) {
  const file = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    const kp = Keypair.generate();
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    log(`generated ${name}: ${kp.publicKey.toBase58()}`);
    return kp;
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

async function ensureFunded(conn, kp, label) {
  const bal = await conn.getBalance(kp.publicKey);
  if (bal >= MIN_BALANCE) {
    log(`${label} balance ${bal / LAMPORTS_PER_SOL} SOL — OK`);
    return true;
  }
  for (let i = 0; i < 3; i++) {
    try {
      log(`airdropping 1 SOL to ${label} (${kp.publicKey.toBase58()})...`);
      const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      return true;
    } catch (e) {
      log(`airdrop attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error(
    `\n[devnet-run] faucet rate-limited. Fund ${label} manually at https://faucet.solana.com:\n` +
      `  ${kp.publicKey.toBase58()}\nthen rerun this script (keys persist in ${DIR}).`,
  );
  return false;
}

function loadState() {
  return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
}

function run(cmd, args, env, label) {
  log(`=== ${label} ===`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${label} FAILED (exit ${r.status})`);
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  log(`rpc: ${RPC}`);
  log(`state dir: ${DIR}`);
  const conn = new Connection(RPC, "confirmed");

  const payer = keypair("payer");
  const submitter = keypair("submitter");
  const opA = keypair("opA");
  const opB = keypair("opB");
  keypair("recipient");
  const nonce = keypair("nonce");

  const ok = (await ensureFunded(conn, payer, "payer")) & (await ensureFunded(conn, submitter, "submitter"));
  if (!ok) process.exit(1);

  if (PROOF === "both" || PROOF === "pegout") {
    run("node", [path.join(REPO, "tools/solana-pegout-proof.cjs")], {
      SOLANA_RPC_URL: RPC,
      PROOF_PAYER_FILE: path.join(DIR, "payer.json"),
    }, "PEG-OUT burn proof");
  }

  if (PROOF === "both" || PROOF === "pegin") {
    const state = loadState();

    if (!state.mint || !state.multisig) {
      log("deploying wVIZ Token-2022 mint + 2-of-2 SPL multisig...");
      const r = spawnSync("npm", ["run", "--silent", "deploy:solana"], {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          SOLANA_RPC_URL: RPC,
          DEPLOY_SEND: "1",
          SOLANA_THRESHOLD: "2",
          SOLANA_SIGNERS: [opA.publicKey.toBase58(), opB.publicKey.toBase58()].join(","),
          SOLANA_PAYER_SECRET: fs.readFileSync(path.join(DIR, "payer.json"), "utf8"),
        },
      });
      process.stdout.write(r.stdout || "");
      process.stderr.write(r.stderr || "");
      if (r.status !== 0) throw new Error("deploy:solana FAILED");
      const mint = ((r.stdout.match(/mint created: (\S+)/g) || []).pop() || "").split(" ").pop();
      const multisig = ((r.stdout.match(/^\[deploy:solana\] multisig: (\S+)/m) || [])[1]) || "";
      if (!mint || !multisig) throw new Error("could not parse mint/multisig from deploy output");
      Object.assign(state, { mint, multisig });
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
      log(`mint=${mint} multisig=${multisig}`);
    } else {
      log(`reusing mint=${state.mint} multisig=${state.multisig}`);
    }

    if (!(await conn.getAccountInfo(nonce.publicKey))) {
      log(`creating durable nonce account ${nonce.publicKey.toBase58()} (authority = submitter)...`);
      const lamports = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const tx = new Transaction().add(
        ...SystemProgram.createNonceAccount({
          fromPubkey: submitter.publicKey,
          noncePubkey: nonce.publicKey,
          authorizedPubkey: submitter.publicKey,
          lamports,
        }).instructions,
      );
      await sendAndConfirmTransaction(conn, tx, [submitter, nonce]);
      // devnet RPC is load-balanced: wait until a fresh read sees the account,
      // or the proof's own connection may race ahead of propagation.
      for (let i = 0; i < 15 && !(await conn.getAccountInfo(nonce.publicKey)); i++) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } else {
      log("nonce account exists — reusing");
    }

    run("node", [path.join(REPO, "tools/solana-devnet-proof.cjs")], {
      SOLANA_RPC_URL: RPC,
      PROOF_DIR: DIR,
      SOLANA_WVIZ_MINT: state.mint,
      SOLANA_MULTISIG: state.multisig,
      SOLANA_NONCE_ACCOUNT: nonce.publicKey.toBase58(),
    }, "PEG-IN mint round-trip");
  }

  log(`ALL REQUESTED PROOFS PASSED (PROOF=${PROOF})`);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
