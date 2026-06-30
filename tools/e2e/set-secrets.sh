#!/usr/bin/env bash
# Push the 16 E2E secrets from .env.e2e to GitHub Actions repo secrets.
#
#   cp .env.e2e.example .env.e2e   # fill in once
#   tools/e2e/set-secrets.sh                 # push to the origin repo
#   tools/e2e/set-secrets.sh --dry-run       # print what would be set (values masked)
#   tools/e2e/set-secrets.sh --repo owner/x  # target a specific repo
#
# Requires the `gh` CLI authenticated with repo admin scope.
set -euo pipefail

# shellcheck source=tools/e2e/secrets.lib.sh
source "$(dirname "$0")/secrets.lib.sh"

DRY_RUN=0
REPO_ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo) REPO_ARG=(--repo "$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi

e2e_load_env
e2e_assert_complete

for name in "${E2E_VARS[@]}"; do
  value="${!name}"
  if (( DRY_RUN )); then
    printf '  would set %-32s (%d chars)\n' "$name" "${#value}"
  else
    printf 'gh secret set %-32s ... ' "$name"
    gh secret set "$name" "${REPO_ARG[@]}" --body "$value"
  fi
done

if (( DRY_RUN )); then
  echo "[set-secrets] dry run — ${#E2E_VARS[@]} secrets would be set. Re-run without --dry-run to apply."
else
  echo "[set-secrets] done — ${#E2E_VARS[@]} secrets set."
fi
