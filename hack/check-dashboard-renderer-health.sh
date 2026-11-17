#!/usr/bin/env bash
# Use the deployer's existing pods/portforward permission; never require exec.
set -euo pipefail

namespace="${1:?namespace required}"
release="${2:?release required}"
work="$(mktemp -d)"
kubectl -n "$namespace" port-forward --address 127.0.0.1 \
  "deployment/$release-observability-gateway" 19081:9081 > "$work/port-forward.log" 2>&1 &
port_forward_pid=$!
cleanup() {
  kill "$port_forward_pid" 2>/dev/null || true
  wait "$port_forward_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for attempt in {1..30}; do
  if ! kill -0 "$port_forward_pid" 2>/dev/null; then
    cat "$work/port-forward.log" >&2
    echo 'Dashboard renderer port-forward exited before verification' >&2
    exit 1
  fi
  # Wait for our listener so an unrelated process on this port cannot pass.
  if grep -Fq 'Forwarding from 127.0.0.1:19081 -> 9081' "$work/port-forward.log" &&
    status="$(curl --fail --silent --show-error --max-time 2 --output "$work/healthz" \
      --write-out '%{http_code}' http://127.0.0.1:19081/healthz 2>/dev/null)" &&
    [[ "$status" == 200 && "$(cat "$work/healthz")" == ok ]]; then
    exit 0
  fi
  sleep 1
done
cat "$work/port-forward.log" >&2
echo 'Dashboard renderer did not return HTTP 200 with body ok within 30 attempts' >&2
exit 1
