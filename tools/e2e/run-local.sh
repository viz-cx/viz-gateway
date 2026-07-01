#!/usr/bin/env bash
# Run the live TON round-trip locally using secrets from .env.e2e.
#
#   cp .env.e2e.example .env.e2e   # fill in once
#   tools/e2e/run-local.sh
#
# Loads + validates the 17 E2E vars, then runs `npm run e2e:ton`.
set -euo pipefail

# shellcheck source=tools/e2e/secrets.lib.sh
source "$(dirname "$0")/secrets.lib.sh"

e2e_load_env
e2e_assert_complete
echo "[run-local] all ${#E2E_VARS[@]} E2E vars present; starting round trip..."

cd "$(e2e_repo_root)"
exec npm run e2e:ton
