#!/usr/bin/env bash
# Renders the chart's PrometheusRule and runs promtool check rules and promtool
# test rules against it. promtool runs from the pinned prom/prometheus image
# (docker, no network) unless PROMTOOL names a local binary. HELM_BIN selects helm.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
tests="$root/charts/chart/tests/prometheus"
image="prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62"
helm_bin="${HELM_BIN:-helm}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --kube-version: helm v3 defaults to Kubernetes 1.20, below the chart's 1.27 floor.
"$helm_bin" template paprika "$root/charts/chart" --namespace paprika-system \
  --kube-version 1.30.0 --set prometheus.rules.enabled=true > "$work/all.yaml"
python3 - "$work/all.yaml" "$work/rules.yaml" <<'PY'
import sys
import yaml

docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
rules = [d for d in docs if d.get("kind") == "PrometheusRule"]
if len(rules) != 1:
    sys.exit(f"expected one PrometheusRule in the render, found {len(rules)}")
with open(sys.argv[2], "w") as f:
    yaml.safe_dump({"groups": rules[0]["spec"]["groups"]}, f, sort_keys=False)
PY
cp "$tests"/*.yaml "$work/"

promtool() {
  if [[ -n "${PROMTOOL:-}" ]]; then
    (cd "$work" && "$PROMTOOL" "$@")
  else
    docker run --rm --network=none -v "$work:/work" -w /work \
      --entrypoint=/bin/promtool "$image" "$@"
  fi
}

promtool check rules rules.yaml
promtool test rules alerts_test.yaml
