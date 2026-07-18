#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart_dir="${repo_root}/charts/chart"
release="admin"
namespace="admin-system"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 1
  fi
}

render_and_verify() {
  local mode="$1"
  local runtime_mode="$2"
  local enabled="$3"
  local sharded="$4"
  local label="${mode}-mode-${runtime_mode}-enabled-${enabled}-sharded-${sharded}"
  local first="${tmp_dir}/${label}.yaml"
  local second="${tmp_dir}/${label}.repeat.yaml"
  local expected_args=0
  local actual_args

  helm template "${release}" "${chart_dir}" \
    --namespace "${namespace}" \
    --set "deploymentMode=${mode}" \
    --set "mode=${runtime_mode}" \
    --set "adminDashboard.enabled=${enabled}" \
    --set "manager.sharding.enabled=${sharded}" \
    --set "repoServer.enabled=true" \
    --set "agent.enabled=true" >"${first}"
  helm template "${release}" "${chart_dir}" \
    --namespace "${namespace}" \
    --set "deploymentMode=${mode}" \
    --set "mode=${runtime_mode}" \
    --set "adminDashboard.enabled=${enabled}" \
    --set "manager.sharding.enabled=${sharded}" \
    --set "repoServer.enabled=true" \
    --set "agent.enabled=true" >"${second}"

  if ! cmp -s "${first}" "${second}"; then
    echo "${label}: Helm rendering is not deterministic" >&2
    exit 1
  fi
  if grep -Fq "3001" "${first}"; then
    echo "${label}: private admin port 3001 appeared in rendered YAML" >&2
    exit 1
  fi

  if [[ "${enabled}" == "true" && ( "${mode}" == "split" || "${runtime_mode}" == "operator" || "${runtime_mode}" == "api" ) ]]; then
    expected_args=1
    if [[ "${mode}" == "split" ]]; then
      expected_args=2
    fi
  fi
  actual_args="$(
    awk '$0 ~ /^[[:space:]]*- --admin-dashboard-enabled$/ { count++ } END { print count + 0 }' \
      "${first}"
  )"
  if [[ "${actual_args}" -ne "${expected_args}" ]]; then
    echo "${label}: found ${actual_args} eligible admin args, want ${expected_args}" >&2
    exit 1
  fi
}

require_command helm
require_command go
require_command cmp
require_command grep
require_command awk

(
  cd "${repo_root}"
  go test ./charts/chart/tests \
    -run 'TestAdminDashboard(ExposureSurfaces|EnabledRequiresBoolean|RejectsRemoteClusterClient)' \
    -count=1
)

for runtime_mode in operator api webhook repo-server agent; do
  for dashboard_enabled in false true; do
    for manager_sharded in false true; do
      render_and_verify "monolith" "${runtime_mode}" "${dashboard_enabled}" "${manager_sharded}"
    done
  done
done
for dashboard_enabled in false true; do
  for manager_sharded in false true; do
    render_and_verify "split" "operator" "${dashboard_enabled}" "${manager_sharded}"
  done
done

test_values_first="${tmp_dir}/test-values.yaml"
test_values_second="${tmp_dir}/test-values.repeat.yaml"
helm template "${release}" "${chart_dir}" \
  --namespace "${namespace}" \
  --values "${repo_root}/deploy/test-values.yaml" >"${test_values_first}"
helm template "${release}" "${chart_dir}" \
  --namespace "${namespace}" \
  --values "${repo_root}/deploy/test-values.yaml" >"${test_values_second}"

if ! cmp -s "${test_values_first}" "${test_values_second}"; then
  echo "deploy/test-values.yaml: Helm rendering is not deterministic" >&2
  exit 1
fi
if grep -Fq "3001" "${test_values_first}"; then
  echo "deploy/test-values.yaml: private admin port 3001 appeared in rendered YAML" >&2
  exit 1
fi

echo "admin-dashboard Helm checks passed: 25 configurations, 50 deterministic renders; parsed exposure and trust-boundary cases"
