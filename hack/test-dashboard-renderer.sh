#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin"
cat > "$temporary/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_CALLS"
case "$*" in
  'config current-context') printf '%s\n' "${TEST_CONTEXT:-vke}" ;;
  *'get deployment'*) printf '%s' "${TEST_IMAGE:-}" ;;
  *'get secret'*'-o name'*) if [[ "${TEST_EXISTS:-true}" == true ]]; then printf 'secret/test-renderer\n'; fi ;;
  *'get secret'*'-o json') printf '{"data":{"secret":"%s"}}\n' "$(printf '%s' "${TEST_SECRET:-synthetic-test-secret-with-at-least-32-bytes}" | base64 | tr -d '\n')" ;;
  *'create secret generic'*)
    value="$(cat)"
    [[ ${#value} -ge 32 ]]
    printf 'secret/test-renderer created\n'
    ;;
  *) exit 80 ;;
esac
MOCK
chmod +x "$temporary/bin/kubectl"
export PATH="$temporary/bin:$PATH" TEST_CALLS="$temporary/calls"
digest="ghcr.io/paprikacd/paprika-render-worker@sha256:$(printf '%064d' 0)"
output="$temporary/values.json"

if bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika bad "$output" 2>/dev/null; then
  echo 'invalid image was accepted' >&2; exit 1
fi
[[ ! -f "$TEST_CALLS" ]]
if TEST_CONTEXT=other bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" 2>/dev/null; then
  echo 'wrong cluster context was accepted' >&2; exit 1
fi
! grep -q 'create secret' "$TEST_CALLS"

TEST_IMAGE="$digest" bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika '' "$output"
jq -e --arg image "$digest" '.observabilityGateway.renderWorker.enabled and .observabilityGateway.renderWorker.image == $image and .observabilityGateway.renderWorker.uiOrigin == "http://paprika-api-server.ns.svc.cluster.local:3000"' "$output" >/dev/null
! grep -q 'create secret' "$TEST_CALLS"
! grep -q 'synthetic-test-secret' "$output"

bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika '' "$output"
jq -e '.observabilityGateway.renderWorker.enabled == false' "$output" >/dev/null

TEST_EXISTS=false bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" > "$temporary/log"
grep -q 'create secret generic paprika-dashboard-renderer' "$TEST_CALLS"
! grep -q 'synthetic-test-secret' "$temporary/log" "$output"
if TEST_SECRET=short bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" 2>/dev/null; then
  echo 'short existing secret was accepted' >&2; exit 1
fi
echo 'PASS dashboard renderer digest, context, retention and secret provisioning'
