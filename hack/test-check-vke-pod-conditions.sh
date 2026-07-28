#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT_DIR/hack/check-vke-pod-conditions.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"$TMP_DIR/kubectl" <<'KUBECTL'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${KUBECTL_ARGS_FILE:?}"

component=""
case "$*" in
  *"control-plane=controller-manager"*) component="controller-manager" ;;
  *"app.kubernetes.io/component=api-server"*) component="api-server" ;;
  *"app.kubernetes.io/component=webhook-receiver"*) component="webhook-receiver" ;;
  *"app.kubernetes.io/component=repo-server"*) component="repo-server" ;;
  *) printf 'unexpected kubectl invocation: %s\n' "$*" >&2; exit 42 ;;
esac

if [ "${FAKE_UNREADY_COMPONENT:-}" = "$component" ]; then
  printf '{"items":[{"metadata":{},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}]}}]}'
elif [ "$component" = "controller-manager" ]; then
  printf '{"items":[{"metadata":{"deletionTimestamp":"2026-07-28T09:02:48Z"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
else
  printf '{"items":[{"metadata":{},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
fi
KUBECTL
chmod +x "$TMP_DIR/kubectl"

export PATH="$TMP_DIR:$PATH"
export KUBECTL_ARGS_FILE="$TMP_DIR/kubectl.args"
export VKE_NAMESPACE="paprika-e2e"
export HELM_RELEASE="paprika-e2e"

OUTPUT="$("$SCRIPT")"
grep -q 'All components healthy (4 passed)' <<<"$OUTPUT" || fail "healthy rollout should pass"
if [ "$(wc -l <"$KUBECTL_ARGS_FILE" | tr -d ' ')" -ne 4 ]; then
  fail "each component must use exactly one Kubernetes snapshot"
fi
grep -q 'control-plane=controller-manager,app.kubernetes.io/instance=paprika-e2e' "$KUBECTL_ARGS_FILE" || fail "controller selector must be release-scoped"

export FAKE_UNREADY_COMPONENT="api-server"
if "$SCRIPT" >"$TMP_DIR/unready.out" 2>"$TMP_DIR/unready.err"; then
  fail "an active unready pod should fail validation"
fi
grep -q 'FAIL  api-server: 0/1 active pods Ready' "$TMP_DIR/unready.out" || fail "unready failure should identify the component"

unset VKE_NAMESPACE
if "$SCRIPT" >"$TMP_DIR/missing.out" 2>"$TMP_DIR/missing.err"; then
  fail "missing namespace should fail validation"
fi
grep -q 'VKE_NAMESPACE is required' "$TMP_DIR/missing.err" || fail "missing namespace error was not helpful"

printf 'PASS: check-vke-pod-conditions\n'
