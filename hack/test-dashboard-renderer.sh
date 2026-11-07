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
digest="ghcr.io/paprikacd/paprika@sha256:$(printf '%064d' 0)"
legacy_digest="ghcr.io/paprikacd/paprika-render-worker@sha256:$(printf '%064d' 0)"
output="$temporary/values.json"

for invalid in bad ghcr.io/paprikacd/paprika:latest ghcr.io/paprikacd/paprika-render-worker:latest "${digest/paprikacd/another-owner}" "${digest/paprika@/paprika-other@}"; do
  if bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$invalid" "$output" 2>/dev/null; then
    echo 'invalid image was accepted' >&2; exit 1
  fi
done
[[ ! -f "$TEST_CALLS" ]]
if TEST_CONTEXT=other bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" 2>/dev/null; then
  echo 'wrong cluster context was accepted' >&2; exit 1
fi
! grep -q 'create secret' "$TEST_CALLS"

for retained in "$digest" "$legacy_digest"; do
  TEST_IMAGE="$retained" bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika '' "$output"
  jq -e --arg image "$retained" '.observabilityGateway.renderWorker.enabled and .observabilityGateway.renderWorker.image == $image and .observabilityGateway.renderWorker.uiOrigin == "http://paprika-api-server.ns.svc.cluster.local:3000"' "$output" >/dev/null
  ! grep -q 'create secret' "$TEST_CALLS"
  ! grep -q 'synthetic-test-secret' "$output"
done

bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika '' "$output"
jq -e '.observabilityGateway.renderWorker.enabled == false' "$output" >/dev/null

TEST_EXISTS=false bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" > "$temporary/log"
grep -q 'create secret generic paprika-dashboard-renderer' "$TEST_CALLS"
! grep -q 'synthetic-test-secret' "$temporary/log" "$output"
if TEST_SECRET=short bash "$repo/hack/prepare-dashboard-renderer.sh" ns paprika "$digest" "$output" 2>/dev/null; then
  echo 'short existing secret was accepted' >&2; exit 1
fi
echo 'PASS dashboard renderer digest, context, retention and secret provisioning'

# The publication preflight must be independent of both persisted and
# environment-provided registry credentials, and propagate denied access.
cat > "$temporary/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 5 && "$1" == --config && "$3" == manifest && "$4" == inspect ]]
[[ "$2" != "${DOCKER_CONFIG:-}" && -z "${DOCKER_AUTH_CONFIG+x}" ]]
jq -e '. == {"auths":{"ghcr.io":{}}}' "$2/config.json" >/dev/null
printf '%s\t%s\n' "$2" "$5" >> "$TEST_DOCKER_CALLS"
[[ "$5" != "${TEST_DENIED_IMAGE:-}" ]]
MOCK
chmod +x "$temporary/bin/docker"
export TEST_DOCKER_CALLS="$temporary/docker-calls"
mkdir -p "$temporary/publisher-config"
printf '%s\n' '{"auths":{"ghcr.io":{"auth":"synthetic-publisher-credential"}},"credsStore":"synthetic-helper"}' > "$temporary/publisher-config/config.json"
cp "$temporary/publisher-config/config.json" "$temporary/publisher-config.expected"

DOCKER_CONFIG="$temporary/publisher-config" DOCKER_AUTH_CONFIG=synthetic-environment-credential \
  bash "$repo/hack/check-anonymous-image-access.sh" "$digest" "$legacy_digest"
[[ $(wc -l < "$TEST_DOCKER_CALLS") -eq 2 ]]
while IFS=$'\t' read -r config image; do
  [[ ! -e "$config" ]]
  [[ "$image" == "$digest" || "$image" == "$legacy_digest" ]]
done < "$TEST_DOCKER_CALLS"
cmp "$temporary/publisher-config/config.json" "$temporary/publisher-config.expected"

: > "$TEST_DOCKER_CALLS"
if TEST_DENIED_IMAGE="$legacy_digest" bash "$repo/hack/check-anonymous-image-access.sh" "$digest" "$legacy_digest"; then
  echo 'denied anonymous image access was accepted' >&2; exit 1
fi
[[ $(wc -l < "$TEST_DOCKER_CALLS") -eq 2 ]]
while IFS=$'\t' read -r config image; do
  [[ ! -e "$config" ]]
done < "$TEST_DOCKER_CALLS"

: > "$TEST_DOCKER_CALLS"
if bash "$repo/hack/check-anonymous-image-access.sh" 2>/dev/null; then
  echo 'empty anonymous image preflight was accepted' >&2; exit 1
fi
if bash "$repo/hack/check-anonymous-image-access.sh" "$digest" ghcr.io/paprikacd/paprika:latest 2>/dev/null; then
  echo 'mutable image reached the anonymous preflight' >&2; exit 1
fi
[[ ! -s "$TEST_DOCKER_CALLS" ]]
echo 'PASS anonymous registry access isolation, exact digests, cleanup and denied access'
