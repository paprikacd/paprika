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

require_cmd kubectl
require_cmd jq
require_env VKE_NAMESPACE
require_env HELM_RELEASE

pass=0
failures=0
for component in controller-manager api-server webhook-receiver repo-server; do
  selector="app.kubernetes.io/component=${component},app.kubernetes.io/instance=${HELM_RELEASE}"
  if [ "$component" = "controller-manager" ]; then
    selector="control-plane=controller-manager,app.kubernetes.io/instance=${HELM_RELEASE}"
  fi

  pod_json="$(kubectl get pods -n "${VKE_NAMESPACE}" -l "$selector" -o json)"
  active="$(printf '%s' "$pod_json" | jq '[.items[] | select(.metadata.deletionTimestamp == null)] | length')"
  ready="$(printf '%s' "$pod_json" | jq '[
    .items[]
    | select(.metadata.deletionTimestamp == null)
    | select(.status.phase == "Running")
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
  ] | length')"

  if [ "$ready" -gt 0 ] && [ "$ready" -eq "$active" ]; then
    printf '  PASS  %s: %s/%s active pods Ready\n' "$component" "$ready" "$active"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s: %s/%s active pods Ready\n' "$component" "$ready" "$active"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  printf 'FAIL: %s component(s) have unhealthy pods\n' "$failures" >&2
  exit 1
fi

printf 'All components healthy (%s passed)\n' "$pass"
