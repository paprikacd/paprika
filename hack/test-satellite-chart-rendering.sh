#!/usr/bin/env bash
# Guard the satellite's deployment and credential/RBAC boundaries without a
# Kubernetes cluster or any real credential.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="${ROOT_DIR}/charts/satellite"
SATELLITE_TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$SATELLITE_TEST_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

render() {
  helm template satellite "${CHART}" \
    --namespace satellite-system \
    --set-string controlPlaneURL=https://paprika.example.com \
    --set-string cluster.name=edge-eu \
    --set-string token.existingSecret=existing-satellite-token \
    --set-string image.tag=satellite-build-test \
    "$@"
}

helm lint "${CHART}" \
  --set-string controlPlaneURL=https://paprika.example.com \
  --set-string cluster.name=edge-eu \
  --set-string token.existingSecret=existing-satellite-token \
  --set-string image.tag=satellite-build-test

render > "${SATELLITE_TEST_DIR}/default.yaml"
output="$(cat "${SATELLITE_TEST_DIR}/default.yaml")"
[[ "$(grep -c '^kind: Deployment$' "${SATELLITE_TEST_DIR}/default.yaml")" == 1 ]] || fail 'expected one satellite Deployment'
[[ "${output}" == *'replicas: 1'* && "${output}" == *'type: Recreate'* ]] || fail 'overlapping satellite sessions must be prevented during upgrades'
if grep -Eq '^kind: (Secret|Service|DaemonSet)$' "${SATELLITE_TEST_DIR}/default.yaml"; then
  fail 'satellite must use an existing credential and outbound transport'
fi
[[ "${output}" == *'secretName: "existing-satellite-token"'* ]] || fail 'satellite token must reference the existing Secret'
[[ "${output}" == *'--satellite-token-file=/var/run/paprika-satellite/token'* ]] || fail 'satellite must authenticate from its mounted token file'
[[ "${output}" == *'defaultMode: 0440'* ]] || fail 'satellite token permissions must be restricted'
[[ "${output}" == *'readOnlyRootFilesystem: true'* && "${output}" == *'allowPrivilegeEscalation: false'* ]] || fail 'satellite container security context is missing'
if grep -Eq -- '--satellite-token=|PAPRIKA_SATELLITE_TOKEN:' "${SATELLITE_TEST_DIR}/default.yaml"; then
  fail 'satellite token must not appear in command arguments or a literal environment value'
fi

awk '/^kind: ClusterRole$/ { role=1; next } /^---$/ { role=0 } role { print }' \
  "${SATELLITE_TEST_DIR}/default.yaml" > "${SATELLITE_TEST_DIR}/role.yaml"
if grep -Eq '(create|delete|update|patch|impersonate|escalate|bind|secrets|configmaps|\*)' "${SATELLITE_TEST_DIR}/role.yaml"; then
  fail 'satellite ClusterRole must only grant inventory reads'
fi
[[ "$(grep -c 'verbs: \[get, list, watch\]' "${SATELLITE_TEST_DIR}/role.yaml")" == 3 ]] || fail 'watched resources must have get/list/watch access'
[[ "$(grep -c 'verbs: \[get\]' "${SATELLITE_TEST_DIR}/role.yaml")" == 1 ]] || fail 'Kubernetes version discovery must have get-only access'

for missing in controlPlaneURL cluster.name token.existingSecret image.tag; do
  if render --set-string "${missing}=" > "${SATELLITE_TEST_DIR}/invalid.yaml" 2>&1; then
    fail "missing ${missing} unexpectedly rendered successfully"
  fi
done

render \
  --set-string ca.existingConfigMap=satellite-private-ca \
  --set-string ca.key=trust.pem \
  --set serviceAccount.create=false \
  --set-string serviceAccount.name=existing-reader \
  --set rbac.create=false \
  --set-string image.repository=ghcr.io/paprikacd/paprika@sha256:0123456789abcdef \
  --set-string image.tag= \
  > "${SATELLITE_TEST_DIR}/custom.yaml"
custom="$(cat "${SATELLITE_TEST_DIR}/custom.yaml")"
if grep -Eq '^kind: (ServiceAccount|ClusterRole|ClusterRoleBinding)$' "${SATELLITE_TEST_DIR}/custom.yaml"; then
  fail 'external service account/RBAC configuration unexpectedly created RBAC objects'
fi
[[ "${custom}" == *'serviceAccountName: existing-reader'* ]] || fail 'external service account was not used'
[[ "${custom}" == *'ghcr.io/paprikacd/paprika@sha256:0123456789abcdef"'* ]] || fail 'immutable image digest was modified'
[[ "${custom}" == *'--satellite-ca-file=/var/run/paprika-satellite-ca/ca.crt'* ]] || fail 'private CA flag is missing'
[[ "${custom}" == *'name: "satellite-private-ca"'* && "${custom}" == *'key: "trust.pem"'* ]] || fail 'private CA ConfigMap is missing'

if render --set serviceAccount.create=false > "${SATELLITE_TEST_DIR}/invalid-sa.yaml" 2>&1; then
  fail 'external service account without a name unexpectedly rendered successfully'
fi

helm template control "${ROOT_DIR}/charts/chart" \
  --show-only templates/crd/clusters.clusters.paprika.io.yaml \
  > "${SATELLITE_TEST_DIR}/cluster-crd.yaml"
for field in satellite tokenSecretRef clusterUid sessionId sequence reportDigest retiredSessions lastSeen applications; do
  grep -Eq "^[[:space:]]+${field}:$" "${SATELLITE_TEST_DIR}/cluster-crd.yaml" \
    || fail "central Cluster CRD is missing satellite field ${field}"
done
grep -Eq '^[[:space:]]+maxItems: 2000$' "${SATELLITE_TEST_DIR}/cluster-crd.yaml" \
  || fail 'central Cluster CRD must bound persisted satellite applications'
grep -Eq '^[[:space:]]+maxItems: 16$' "${SATELLITE_TEST_DIR}/cluster-crd.yaml" \
  || fail 'central Cluster CRD must bound retired reporting sessions'
grep -Fq '"helm.sh/resource-policy": keep' "${SATELLITE_TEST_DIR}/cluster-crd.yaml" \
  || fail 'central Cluster CRD must preserve Helm keep annotation'
helm template control "${ROOT_DIR}/charts/chart" --set crd.enable=false \
  > "${SATELLITE_TEST_DIR}/central-without-crds.yaml"
if grep -Fq 'name: clusters.clusters.paprika.io' "${SATELLITE_TEST_DIR}/central-without-crds.yaml"; then
  fail 'central Cluster CRD must honor crd.enable=false'
fi

printf 'Satellite chart credential, transport, and RBAC checks passed.\n'
