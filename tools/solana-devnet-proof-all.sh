#!/usr/bin/env bash
# Turnkey Solana live-proof driver: runs BOTH the peg-in mint round-trip and the
# peg-out burn proof from zero against a fresh local `solana-test-validator`.
#
# It stitches together the two manual sequences already in RUNBOOK.md
# ("How peg-in mint works on Solana" / "How peg-out burn works on Solana") plus
# the one step that is otherwise undocumented: `anchor build` to produce the
# gateway_deposit .so the peg-out proof deploys.
#
#   tools/solana-devnet-proof-all.sh            # both proofs
#   PROOF=pegin  tools/solana-devnet-proof-all.sh   # mint round-trip only
#   PROOF=pegout tools/solana-devnet-proof-all.sh   # burn proof only
#   KEEP_VALIDATOR=1 tools/solana-devnet-proof-all.sh  # leave the validator running
#
# Prerequisites (see docs/runbook-solana-devnet-cutover.md for install commands):
#   - Node 22+, `npm install` + `npm run build` done in the repo root.
#   - Solana CLI (agave) on PATH: provides solana / solana-keygen / solana-test-validator.
#   - Rust toolchain + Anchor CLI (`anchor`) — only needed for the peg-out proof
#     (to build the gateway_deposit program). The peg-in proof does not need Anchor.
#
# This talks ONLY to a local validator (http://127.0.0.1:8899). It never touches
# devnet or mainnet, generates throwaway keys under a temp dir, and tears the
# validator down on exit unless KEEP_VALIDATOR=1.
set -euo pipefail

RPC="http://127.0.0.1:8899"
PROOF="${PROOF:-both}"        # both | pegin | pegout
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$(mktemp -d /tmp/viz-solana-proof.XXXXXX)"
VALIDATOR_PID=""
VALIDATOR_LEDGER="$WORKDIR/ledger"

log()  { printf '\033[36m[proof-all]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[proof-all] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$VALIDATOR_PID" && "${KEEP_VALIDATOR:-0}" != "1" ]]; then
    log "stopping test validator (pid $VALIDATOR_PID)"
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_VALIDATOR:-0}" == "1" ]]; then
    log "KEEP_VALIDATOR=1 — validator (pid $VALIDATOR_PID) and keys under $WORKDIR left in place"
  else
    rm -rf "$WORKDIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- preflight: required tools --------------------------------------------------
command -v solana            >/dev/null || fail "solana CLI not on PATH (see docs/runbook-solana-devnet-cutover.md)"
command -v solana-keygen     >/dev/null || fail "solana-keygen not on PATH"
command -v solana-test-validator >/dev/null || fail "solana-test-validator not on PATH"
command -v node              >/dev/null || fail "node not on PATH"
[[ -d "$REPO_ROOT/packages/solana-watcher/dist" ]] || fail "dist/ missing — run 'npm run build' first"

if [[ "$PROOF" == "both" || "$PROOF" == "pegout" ]]; then
  SO="$REPO_ROOT/contracts/solana/target/deploy/gateway_deposit.so"
  if [[ ! -f "$SO" ]]; then
    command -v anchor >/dev/null || fail "gateway_deposit.so absent and 'anchor' not on PATH — install Anchor or run PROOF=pegin"
    log "building gateway_deposit program (anchor build)..."
    ( cd "$REPO_ROOT/contracts/solana" && anchor build ) || fail "anchor build failed"
    [[ -f "$SO" ]] || fail "anchor build did not produce $SO"
  fi
  log "gateway_deposit .so present: $SO"
fi

# --- boot a fresh local validator ----------------------------------------------
log "starting solana-test-validator (fresh ledger under $WORKDIR)..."
solana-test-validator --reset --quiet --ledger "$VALIDATOR_LEDGER" >"$WORKDIR/validator.log" 2>&1 &
VALIDATOR_PID=$!

# Wait for RPC readiness instead of a blind sleep.
log "waiting for validator RPC..."
for i in $(seq 1 30); do
  if solana -u "$RPC" cluster-version >/dev/null 2>&1; then break; fi
  kill -0 "$VALIDATOR_PID" 2>/dev/null || fail "validator died on startup — see $WORKDIR/validator.log"
  sleep 1
  [[ $i -eq 30 ]] && fail "validator RPC not ready after 30s — see $WORKDIR/validator.log"
done
log "validator up: $(solana -u "$RPC" cluster-version)"

# ================================================================================
# PEG-OUT burn proof (self-contained: the .cjs deploys the program + mints itself)
# ================================================================================
if [[ "$PROOF" == "both" || "$PROOF" == "pegout" ]]; then
  log "=== PEG-OUT burn proof ==="
  SOLANA_RPC_URL="$RPC" node "$REPO_ROOT/tools/solana-pegout-proof.cjs"
  log "peg-out proof PASSED"
fi

# ================================================================================
# PEG-IN mint round-trip (deploy mint + SPL multisig, durable nonce, 2-of-2 mint)
# ================================================================================
if [[ "$PROOF" == "both" || "$PROOF" == "pegin" ]]; then
  log "=== PEG-IN mint round-trip ==="
  S="$WORKDIR/pegin"; mkdir -p "$S"
  for n in payer submitter opA opB recipient nonce; do
    solana-keygen new --no-bip39-passphrase --silent -o "$S/$n.json" --force >/dev/null
  done
  log "funding payer + submitter..."
  solana -u "$RPC" airdrop 100 "$S/payer.json"     >/dev/null
  solana -u "$RPC" airdrop 100 "$S/submitter.json" >/dev/null

  OPA_PUB="$(solana-keygen pubkey "$S/opA.json")"
  OPB_PUB="$(solana-keygen pubkey "$S/opB.json")"
  SUB_PUB="$(solana-keygen pubkey "$S/submitter.json")"
  NONCE_PUB="$(solana-keygen pubkey "$S/nonce.json")"

  log "deploying wVIZ Token-2022 mint + 2-of-2 SPL multisig..."
  DEPLOY_OUT="$(
    SOLANA_RPC_URL="$RPC" DEPLOY_SEND=1 SOLANA_THRESHOLD=2 \
      SOLANA_PAYER_SECRET="$(cat "$S/payer.json")" \
      SOLANA_SIGNERS="$OPA_PUB,$OPB_PUB" \
      npm run --silent deploy:solana
  )"
  echo "$DEPLOY_OUT"
  # `mint created: <addr> (tx ...)` and the standalone `multisig: <addr>` are the
  # authoritative APPLY-path lines (the earlier dry-run-style lines print too).
  MINT="$(echo "$DEPLOY_OUT" | sed -n 's/.*mint created: \([^ ]*\).*/\1/p' | tail -1)"
  MULTISIG="$(echo "$DEPLOY_OUT" | sed -n 's/^\[deploy:solana\] multisig: \([^ ]*\).*/\1/p' | tail -1)"
  [[ -n "$MINT" && -n "$MULTISIG" ]] || fail "could not parse MINT/MULTISIG from deploy output"
  log "mint=$MINT  multisig=$MULTISIG"

  log "creating durable nonce account (authority = submitter)..."
  solana -u "$RPC" -k "$S/submitter.json" create-nonce-account "$S/nonce.json" 0.01 \
    --nonce-authority "$SUB_PUB" >/dev/null

  log "running the live mint round-trip..."
  SOLANA_RPC_URL="$RPC" PROOF_DIR="$S" \
    SOLANA_WVIZ_MINT="$MINT" SOLANA_MULTISIG="$MULTISIG" \
    SOLANA_NONCE_ACCOUNT="$NONCE_PUB" \
    node "$REPO_ROOT/tools/solana-devnet-proof.cjs"
  log "peg-in proof PASSED"
fi

log "ALL REQUESTED PROOFS PASSED (PROOF=$PROOF)"
