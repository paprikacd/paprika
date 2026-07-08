#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf '%s is required\n' "$name" >&2
    exit 1
  fi
}

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf '%s is required\n' "$name" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_env GITHUB_ACTIONS_TOKEN_EXCHANGE_URL

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
credential="$("$ROOT_DIR/hack/github-actions-oidc-token.sh")"
github_token="$(printf '%s' "$credential" | jq -er '.status.token')"
payload="$(jq -cn --arg token "$github_token" '{token: $token}')"

exchange_response="$(
  curl -fsSL \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$GITHUB_ACTIONS_TOKEN_EXCHANGE_URL"
)"

printf '%s' "$exchange_response" | jq -e '
  .apiVersion == "client.authentication.k8s.io/v1"
  and .kind == "ExecCredential"
  and (.status.token | type == "string")
  and (.status.token | length > 0)
' >/dev/null

printf '%s\n' "$exchange_response"
