#!/usr/bin/env bash
# Prepare non-secret Helm values for the optional same-pod browser renderer.
set -euo pipefail

namespace="${1:?namespace required}"
release="${2:?release required}"
renderer_image="${3-}"
output="${4:?values output required}"

valid_image() {
  [[ "$1" =~ ^ghcr\.io/paprikacd/paprika(-render-worker)?@sha256:[0-9a-f]{64}$ ]]
}
if [[ -n "$renderer_image" ]] && ! valid_image "$renderer_image"; then
  echo 'Dashboard renderer requires an immutable image digest' >&2
  exit 1
fi
if [[ ! "$namespace" =~ ^[a-z0-9][a-z0-9-]*$ || ! "$release" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'Invalid namespace or Helm release name' >&2
  exit 1
fi
# The workflow establishes this context. Refuse a write on a different cluster.
if [[ "$(kubectl config current-context)" != vke ]]; then
  echo 'Dashboard renderer setup requires the VKE context' >&2
  exit 1
fi
if [[ -z "$renderer_image" ]]; then
  renderer_image="$(kubectl -n "$namespace" get deployment "$release-observability-gateway" \
    --ignore-not-found -o 'jsonpath={.spec.template.spec.containers[?(@.name=="dashboard-renderer")].image}')"
fi
if [[ -z "$renderer_image" ]]; then
  printf '%s\n' '{"observabilityGateway":{"renderWorker":{"enabled":false}}}' > "$output"
  exit 0
fi
if ! valid_image "$renderer_image"; then
  echo 'Existing dashboard renderer image is not an approved immutable digest' >&2
  exit 1
fi
secret_name="$release-dashboard-renderer"
existing="$(kubectl -n "$namespace" get secret "$secret_name" --ignore-not-found -o name)"
if [[ -z "$existing" ]]; then
  # Never echo or serialize the generated secret into a workflow log or values.
  openssl rand -base64 48 | tr -d '\n' | \
    kubectl -n "$namespace" create secret generic "$secret_name" --from-file=secret=/dev/stdin
fi
secret_size="$(kubectl -n "$namespace" get secret "$secret_name" -o json | jq -r '.data.secret | @base64d | length')"
if [[ ! "$secret_size" =~ ^[0-9]+$ || "$secret_size" -lt 32 ]]; then
  echo 'Dashboard renderer secret must contain at least 32 bytes' >&2
  exit 1
fi
jq -n --arg image "$renderer_image" --arg secret "$secret_name" \
  --arg origin "http://$release-api-server.$namespace.svc.cluster.local:3000" \
  '{observabilityGateway:{renderWorker:{enabled:true,image:$image,secretName:$secret,secretKey:"secret",uiOrigin:$origin}}}' > "$output"
