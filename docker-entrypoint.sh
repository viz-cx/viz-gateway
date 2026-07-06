#!/bin/sh
set -e

# Select which service to run based on $SERVICE. Names match the package dirs and the
# package.json start:* scripts (kept in sync by tools/deploy-consistency-spike.cjs).
case "${SERVICE:-signer}" in
  viz-watcher)     exec node packages/viz-watcher/dist/index.js ;;
  gram-watcher)    exec node packages/gram-watcher/dist/index.js ;;
  solana-watcher)  exec node packages/solana-watcher/dist/index.js ;;
  signer)          exec node packages/signer/dist/index.js ;;
  coordinator)     exec node packages/coordinator/dist/index.js ;;
  dispatcher)      exec node packages/dispatcher/dist/index.js ;;
  recon)           exec node packages/recon/dist/index.js ;;
  lookup)          exec node packages/solana-watcher/dist/lookup.js ;;
  pegout-scanner)  exec node packages/solana-watcher/dist/pegoutScanner.js ;;
  *)
    echo "Unknown SERVICE='$SERVICE' (expected viz-watcher|gram-watcher|solana-watcher|signer|coordinator|dispatcher|recon|lookup|pegout-scanner)" >&2
    exit 1
    ;;
esac
