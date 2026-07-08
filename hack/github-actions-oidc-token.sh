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
require_env ACTIONS_ID_TOKEN_REQUEST_TOKEN
require_env ACTIONS_ID_TOKEN_REQUEST_URL
require_env GITHUB_ACTIONS_OIDC_AUDIENCE

encoded_audience="$(jq -rn --arg value "$GITHUB_ACTIONS_OIDC_AUDIENCE" '$value | @uri')"
separator="&"
case "$ACTIONS_ID_TOKEN_REQUEST_URL" in
  *\?*) separator="&" ;;
  *) separator="?" ;;
esac

response="$(
  curl -fsSL \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}${separator}audience=${encoded_audience}"
)"

token="$(printf '%s' "$response" | jq -er '.value')"

jq -n \
  --arg token "$token" \
  '{
    apiVersion: "client.authentication.k8s.io/v1",
    kind: "ExecCredential",
    status: {
      token: $token
    }
  }'
