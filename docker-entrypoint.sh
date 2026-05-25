#!/bin/sh
set -e

# Select which service to run based on $SERVICE.
case "${SERVICE:-signer}" in
  viz-watcher)  exec node packages/viz-watcher/dist/index.js ;;
  ton-watcher)  exec node packages/ton-watcher/dist/index.js ;;
  solana-watcher) exec node packages/solana-watcher/dist/index.js ;;
  signer)       exec node packages/signer/dist/index.js ;;
  coordinator)  exec node packages/coordinator/dist/index.js ;;
  recon)        exec node packages/recon/dist/index.js ;;
  *)
    echo "Unknown SERVICE='$SERVICE' (expected viz-watcher|ton-watcher|signer|coordinator|recon)" >&2
    exit 1
    ;;
esac
