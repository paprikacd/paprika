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
  '-n ns port-forward --address 127.0.0.1 deployment/paprika-observability-gateway 19081:9081')
    printf '%s\n' "$$" > "$TEST_FORWARD_PID"
    if [[ "${TEST_FORWARD_FAILURE:-false}" == true ]]; then exit 1; fi
    trap 'exit 0' TERM INT
    printf 'Forwarding from 127.0.0.1:19081 -> 9081\n'
    while true; do /bin/sleep 0.05; done
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

cat > "$temporary/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 10 && "$1" == --fail && "$2" == --silent && "$3" == --show-error ]]
[[ "$4" == --max-time && "$5" == 2 && "$6" == --output && "$8" == --write-out ]]
[[ "$9" == '%{http_code}' && "${10}" == http://127.0.0.1:19081/healthz ]]
printf '%s\n' "$7" >> "$TEST_HEALTH_CALLS"
printf '%s' "${TEST_HEALTH_BODY:-ok}" > "$7"
printf '%s' "${TEST_HEALTH_STATUS:-200}"
exit "${TEST_CURL_FAILURE:-0}"
MOCK
cat > "$temporary/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
# Keep the production retry bound while making failure cases fast.
exec /bin/sleep 0.01
MOCK
chmod +x "$temporary/bin/curl" "$temporary/bin/sleep"
export TEST_FORWARD_PID="$temporary/forward-pid" TEST_HEALTH_CALLS="$temporary/health-calls"

assert_forward_cleaned_up() {
  if kill -0 "$(cat "$TEST_FORWARD_PID")" 2>/dev/null; then
    echo 'renderer health check left its port-forward running' >&2; exit 1
  fi
  while IFS= read -r response; do [[ ! -e "$response" ]]; done < "$TEST_HEALTH_CALLS"
}

bash "$repo/hack/check-dashboard-renderer-health.sh" ns paprika
[[ -s "$TEST_HEALTH_CALLS" ]]
assert_forward_cleaned_up
for failure in TEST_CURL_FAILURE=7 TEST_HEALTH_STATUS=503 TEST_HEALTH_BODY=unexpected TEST_FORWARD_FAILURE=true; do
  : > "$TEST_HEALTH_CALLS"
  if env "$failure" bash "$repo/hack/check-dashboard-renderer-health.sh" ns paprika > "$temporary/health-log" 2>&1; then
    echo "renderer health verification accepted $failure" >&2; exit 1
  fi
  [[ $(wc -l < "$TEST_HEALTH_CALLS") -le 30 ]]
  if [[ "$failure" == TEST_FORWARD_FAILURE=true ]]; then
    [[ ! -s "$TEST_HEALTH_CALLS" ]]
  else
    [[ -s "$TEST_HEALTH_CALLS" ]]
  fi
  assert_forward_cleaned_up
done
echo 'PASS renderer loopback health verification, bounded failures and port-forward cleanup'
