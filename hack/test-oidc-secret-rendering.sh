#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="${ROOT_DIR}/charts/chart"
INLINE_ERROR='auth.oidc.clientSecret is no longer supported; create a Kubernetes Secret and set auth.oidc.existingSecretName/existingSecretKey'
PARTIAL_ERROR='auth.oidc.existingSecretName and auth.oidc.existingSecretKey must both be set'
REDIRECT_URL='https://paprika.example.com/auth/callback'

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

render_workload() {
  local template="$1"
  shift
  helm template paprika "${CHART}" \
    --show-only "${template}" \
    --set auth.enabled=true \
    --set auth.oidc.enabled=true \
    --set-string auth.oidc.issuerURL=https://issuer.example.com \
    --set-string auth.oidc.clientID=client-id-marker \
    --set-string auth.oidc.redirectURL="${REDIRECT_URL}" \
    --set-string auth.oidc.existingSecretName=paprika-oidc \
    --set-string auth.oidc.existingSecretKey=client-secret \
    "$@"
}

assert_secret_env() {
  local label="$1"
  local output="$2"
  local secret_block

  secret_block="$(printf '%s\n' "${output}" | awk '
    /- name: PAPRIKA_OIDC_CLIENT_SECRET/ { capture=1; remaining=7 }
    capture { print; remaining-- }
    capture && remaining == 0 { capture=0 }
  ')"
  [[ "${secret_block}" == *'valueFrom:'* ]] || fail "${label}: OIDC secret env does not use valueFrom"
  [[ "${secret_block}" == *'secretKeyRef:'* ]] || fail "${label}: OIDC secret env does not use secretKeyRef"
  [[ "${secret_block}" == *'name: "paprika-oidc"'* ]] || fail "${label}: OIDC secret ref name is missing"
  [[ "${secret_block}" == *'key: "client-secret"'* ]] || fail "${label}: OIDC secret ref key is missing"
  [[ "${output}" != *'DO-NOT-RENDER'* ]] || fail "${label}: inline secret marker was rendered"
  [[ "${output}" != *'--auth-oidc-client-secret'* ]] || fail "${label}: client secret was rendered as a process argument"
  [[ "${output}" == *"--auth-oidc-redirect-url=${REDIRECT_URL}"* ]] || fail "${label}: redirect URL argument is missing"
}

split_output="$(render_workload templates/api-server/deployment.yaml --set-string deploymentMode=split)"
assert_secret_env 'split API Deployment' "${split_output}"

monolith_output="$(render_workload templates/manager/manager.yaml --set-string deploymentMode=monolith --set manager.sharding.enabled=false)"
assert_secret_env 'monolith Deployment' "${monolith_output}"

sharded_output="$(render_workload templates/manager/statefulset.yaml --set-string deploymentMode=monolith --set manager.sharding.enabled=true)"
assert_secret_env 'sharded monolith StatefulSet' "${sharded_output}"

inline_output="$(mktemp)"
if helm template paprika "${CHART}" \
  --set-string deploymentMode=split \
  --set auth.enabled=true \
  --set auth.oidc.enabled=true \
  --set-string auth.oidc.clientSecret=DO-NOT-RENDER >"${inline_output}" 2>&1; then
  fail 'inline OIDC clientSecret unexpectedly rendered successfully'
fi
grep -Fq "${INLINE_ERROR}" "${inline_output}" || fail 'inline clientSecret failure did not contain the migration error'
grep -Fq 'DO-NOT-RENDER' "${inline_output}" && fail 'inline secret marker appeared in Helm failure output'
rm -f "${inline_output}"

for partial in name key; do
  partial_output="$(mktemp)"
  partial_args=(
    template paprika "${CHART}"
    --set-string deploymentMode=split
    --set auth.enabled=true
    --set auth.oidc.enabled=true
  )
  if [[ "${partial}" == name ]]; then
    partial_args+=(--set-string auth.oidc.existingSecretName=paprika-oidc)
  else
    partial_args+=(--set-string auth.oidc.existingSecretKey=client-secret)
  fi
  if helm "${partial_args[@]}" >"${partial_output}" 2>&1; then
    fail "partial OIDC Secret ${partial} configuration unexpectedly rendered successfully"
  fi
  grep -Fq "${PARTIAL_ERROR}" "${partial_output}" || fail "partial OIDC Secret ${partial} failure did not require both settings"
  rm -f "${partial_output}"
done

public_output="$(helm template paprika "${CHART}" \
  --show-only templates/api-server/deployment.yaml \
  --set-string deploymentMode=split \
  --set auth.enabled=true \
  --set auth.oidc.enabled=true \
  --set-string auth.oidc.issuerURL=https://issuer.example.com \
  --set-string auth.oidc.clientID=public-client-marker)"
[[ "${public_output}" != *'PAPRIKA_OIDC_CLIENT_SECRET'* ]] || fail 'public client unexpectedly rendered an OIDC secret environment variable'
[[ "${public_output}" != *'--auth-oidc-client-secret'* ]] || fail 'public client unexpectedly rendered an OIDC secret argument'
[[ "${public_output}" != *'# Source: paprika/templates/validate.yaml'* ]] || fail 'validation template emitted a spurious manifest'

inactive_inline_output="$(mktemp)"
if helm template paprika "${CHART}" \
  --set-string deploymentMode=split \
  --set auth.enabled=false \
  --set auth.oidc.enabled=false \
  --set-string auth.oidc.clientSecret=DO-NOT-RENDER >"${inactive_inline_output}" 2>&1; then
  fail 'inactive inline OIDC clientSecret unexpectedly rendered successfully'
fi
grep -Fq "${INLINE_ERROR}" "${inactive_inline_output}" || fail 'inactive inline clientSecret failure did not contain the migration error'
grep -Fq 'DO-NOT-RENDER' "${inactive_inline_output}" && fail 'inactive inline secret marker appeared in Helm failure output'
rm -f "${inactive_inline_output}"

for partial in name key; do
  inactive_partial_output="$(mktemp)"
  inactive_partial_args=(
    template paprika "${CHART}"
    --set-string deploymentMode=split
    --set auth.enabled=false
    --set auth.oidc.enabled=false
  )
  if [[ "${partial}" == name ]]; then
    inactive_partial_args+=(--set-string auth.oidc.existingSecretName=paprika-oidc)
  else
    inactive_partial_args+=(--set-string auth.oidc.existingSecretKey=client-secret)
  fi
  if helm "${inactive_partial_args[@]}" >"${inactive_partial_output}" 2>&1; then
    fail "inactive partial OIDC Secret ${partial} configuration unexpectedly rendered successfully"
  fi
  grep -Fq "${PARTIAL_ERROR}" "${inactive_partial_output}" || fail "inactive partial OIDC Secret ${partial} failure did not require both settings"
  rm -f "${inactive_partial_output}"
done

disabled_workload_args=(
  template paprika "${CHART}"
  --set-string deploymentMode=monolith
  --set manager.enabled=false
  --set apiServer.enabled=false
  --set webhookReceiver.enabled=false
  --set repoServer.enabled=false
  --set agent.enabled=false
  --set auth.enabled=false
  --set auth.oidc.enabled=false
)

disabled_inline_output="$(mktemp)"
if helm "${disabled_workload_args[@]}" \
  --set-string auth.oidc.clientSecret=DO-NOT-RENDER >"${disabled_inline_output}" 2>&1; then
  fail 'disabled-workload inline OIDC clientSecret unexpectedly rendered successfully'
fi
grep -Fq "${INLINE_ERROR}" "${disabled_inline_output}" || fail 'disabled-workload inline clientSecret failure did not contain the migration error'
grep -Fq 'DO-NOT-RENDER' "${disabled_inline_output}" && fail 'disabled-workload inline secret marker appeared in Helm failure output'
rm -f "${disabled_inline_output}"

for partial in name key; do
  disabled_partial_output="$(mktemp)"
  disabled_partial_args=("${disabled_workload_args[@]}")
  if [[ "${partial}" == name ]]; then
    disabled_partial_args+=(--set-string auth.oidc.existingSecretName=paprika-oidc)
  else
    disabled_partial_args+=(--set-string auth.oidc.existingSecretKey=client-secret)
  fi
  if helm "${disabled_partial_args[@]}" >"${disabled_partial_output}" 2>&1; then
    fail "disabled-workload partial OIDC Secret ${partial} configuration unexpectedly rendered successfully"
  fi
  grep -Fq "${PARTIAL_ERROR}" "${disabled_partial_output}" || fail "disabled-workload partial OIDC Secret ${partial} failure did not require both settings"
  rm -f "${disabled_partial_output}"
done

split_sharded_api_output="$(render_workload templates/api-server/deployment.yaml \
  --set-string deploymentMode=split \
  --set manager.sharding.enabled=true)"
assert_secret_env 'split sharded API Deployment' "${split_sharded_api_output}"

split_sharded_manager_output="$(render_workload templates/manager/statefulset.yaml \
  --set-string deploymentMode=split \
  --set manager.sharding.enabled=true)"
[[ "${split_sharded_manager_output}" != *'PAPRIKA_OIDC_CLIENT_SECRET'* ]] || fail 'split sharded controller StatefulSet unexpectedly owns the OIDC Secret env'
[[ "${split_sharded_manager_output}" != *'--auth-oidc-'* ]] || fail 'split sharded controller StatefulSet unexpectedly receives OIDC arguments'

printf 'OIDC Secret rendering checks passed\n'
