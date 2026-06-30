#!/usr/bin/env bash
# Shared helper for the e2e tooling: the canonical list of E2E secret names
# (must match tools/e2e/config.ts → loadE2eConfig) and a loader for .env.e2e.
#
# Source this; do not execute it directly.

# The 16 vars the harness reads. Single source of truth for both
# run-local.sh and set-secrets.sh so they cannot drift.
E2E_VARS=(
  E2E_VIZ_NODE_URL
  E2E_VIZ_TEST_WIF
  E2E_VIZ_TEST_ACCOUNT
  E2E_VIZ_GATEWAY_ACCOUNT
  E2E_VIZ_RECIPIENT
  E2E_VIZ_MIN_BALANCE_MILLI_VIZ
  E2E_TON_ENDPOINT
  E2E_TON_API_KEY
  E2E_TON_GATEWAY_JETTON_WALLET
  E2E_TON_GATEWAY_OWNER
  E2E_TON_JETTON_MINTER_ADDRESS
  E2E_TON_MULTISIG_ADDRESS
  E2E_TON_SIGNER_MNEMONIC
  E2E_TON_BURN_MNEMONIC
  E2E_TON_BURN_OWNER
  E2E_TON_MIN_GAS_NANO
)

# Resolve the repo root from this file's location so the helpers work from any cwd.
e2e_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# Load .env.e2e (or $E2E_ENV_FILE) into the environment. Exits non-zero with a
# clear message if the file is missing.
e2e_load_env() {
  local root env_file
  root="$(e2e_repo_root)"
  env_file="${E2E_ENV_FILE:-$root/.env.e2e}"
  if [[ ! -f "$env_file" ]]; then
    echo "error: $env_file not found." >&2
    echo "  cp .env.e2e.example .env.e2e   # then fill in the values" >&2
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

# Verify every E2E_VAR is set and non-empty. Lists all missing before exiting.
e2e_assert_complete() {
  local missing=()
  local name
  for name in "${E2E_VARS[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "error: ${#missing[@]} required E2E var(s) missing or empty:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi
}
