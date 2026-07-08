#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT_DIR/hack/github-actions-oidc-token.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local want="$1"
  local got="$2"
  local msg="$3"
  if [ "$want" != "$got" ]; then
    fail "$msg: want '$want', got '$got'"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"$TMP_DIR/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >"${CURL_ARGS_FILE:?}"
case "$*" in
  *"Authorization: bearer request-token"*"https://actions.example/id-token?api-version=2&audience=paprika-vke-deploy%2Fprod"*)
    printf '{"value":"id-token-value"}'
    ;;
  *)
    printf 'unexpected curl invocation: %s\n' "$*" >&2
    exit 42
    ;;
esac
CURL
chmod +x "$TMP_DIR/curl"

export PATH="$TMP_DIR:$PATH"
export CURL_ARGS_FILE="$TMP_DIR/curl.args"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://actions.example/id-token?api-version=2"
export GITHUB_ACTIONS_OIDC_AUDIENCE="paprika-vke-deploy/prod"

OUTPUT="$("$SCRIPT")"

assert_eq "client.authentication.k8s.io/v1" "$(printf '%s' "$OUTPUT" | jq -r '.apiVersion')" "apiVersion"
assert_eq "ExecCredential" "$(printf '%s' "$OUTPUT" | jq -r '.kind')" "kind"
assert_eq "id-token-value" "$(printf '%s' "$OUTPUT" | jq -r '.status.token')" "token"
grep -q 'audience=paprika-vke-deploy%2Fprod' "$CURL_ARGS_FILE" || fail "audience was not URL encoded"

unset GITHUB_ACTIONS_OIDC_AUDIENCE
if "$SCRIPT" >/tmp/github-actions-oidc-token.out 2>/tmp/github-actions-oidc-token.err; then
  fail "script should fail when GITHUB_ACTIONS_OIDC_AUDIENCE is unset"
fi
grep -q 'GITHUB_ACTIONS_OIDC_AUDIENCE is required' /tmp/github-actions-oidc-token.err || fail "missing audience error was not helpful"

printf 'PASS: github-actions-oidc-token\n'
