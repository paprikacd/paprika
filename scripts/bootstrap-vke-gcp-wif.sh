#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kubeconfig="${KUBECONFIG:-${root_dir}/terraform/omega.kubeconfig}"
namespace="${PAPRIKA_NAMESPACE:-paprika-e2e}"
pool_id="${WIF_POOL_ID:-vke-omega}"
provider_id="${WIF_PROVIDER_ID:-omega}"

apps=(
  "brandbrain-486909|brandbrain-api-release|brandbrain-backend@brandbrain-486909.iam.gserviceaccount.com"
  "cuttlefish-d16cd|cuttlefish-controlplane-release|cf-controlplane@cuttlefish-d16cd.iam.gserviceaccount.com"
  "flaggr-478302|flaggr-api-release|flaggr-grpc-sa@flaggr-478302.iam.gserviceaccount.com"
  "uptime-485903|telesis-api-release|telesis-vke-runtime@uptime-485903.iam.gserviceaccount.com"
)

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

need gcloud
need jq
need kubectl

ensure_telesis_runtime_service_account() {
  local project_id="uptime-485903"
  local service_account_name="telesis-vke-runtime"
  local service_account_email="${service_account_name}@${project_id}.iam.gserviceaccount.com"

  if ! gcloud iam service-accounts describe "${service_account_email}" --project="${project_id}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${service_account_name}" \
      --project="${project_id}" \
      --display-name="Telesis VKE runtime" \
      >/dev/null
  fi

  for role in roles/firebaseauth.admin roles/pubsub.publisher roles/pubsub.subscriber roles/pubsub.viewer; do
    gcloud projects add-iam-policy-binding "${project_id}" \
      --member="serviceAccount:${service_account_email}" \
      --role="${role}" \
      --condition=None \
      >/dev/null
  done
}

jwks_file="$(mktemp)"
trap 'rm -f "${jwks_file}"' EXIT

ensure_telesis_runtime_service_account

issuer_uri="$(kubectl --kubeconfig="${kubeconfig}" get --raw /.well-known/openid-configuration | jq -r '.issuer')"
kubectl --kubeconfig="${kubeconfig}" get --raw /openid/v1/jwks >"${jwks_file}"

if [[ -z "${issuer_uri}" || "${issuer_uri}" == "null" ]]; then
  echo "Kubernetes OIDC issuer discovery did not return an issuer" >&2
  exit 1
fi

attribute_mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account_name=assertion['kubernetes.io']['serviceaccount']['name']"
attribute_condition="assertion.sub.startsWith('system:serviceaccount:${namespace}:')"

for app in "${apps[@]}"; do
  IFS='|' read -r project_id ksa_name gsa_email <<<"${app}"
  project_number="$(gcloud projects describe "${project_id}" --format='value(projectNumber)')"
  provider_audience="//iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${provider_id}"
  principal="principal://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/subject/system:serviceaccount:${namespace}:${ksa_name}"

  echo "==> ${project_id}: enabling APIs"
  gcloud services enable \
    --project="${project_id}" \
    sts.googleapis.com \
    iamcredentials.googleapis.com \
    >/dev/null

  echo "==> ${project_id}: ensuring workload identity pool ${pool_id}"
  if ! gcloud iam workload-identity-pools describe "${pool_id}" \
    --project="${project_id}" \
    --location=global \
    >/dev/null 2>&1; then
    gcloud iam workload-identity-pools create "${pool_id}" \
      --project="${project_id}" \
      --location=global \
      --display-name="VKE omega" \
      --description="Vultr VKE omega Kubernetes service account identities" \
      >/dev/null
  fi

  echo "==> ${project_id}: ensuring OIDC provider ${provider_id}"
  if gcloud iam workload-identity-pools providers describe "${provider_id}" \
    --project="${project_id}" \
    --location=global \
    --workload-identity-pool="${pool_id}" \
    >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers update-oidc "${provider_id}" \
      --project="${project_id}" \
      --location=global \
      --workload-identity-pool="${pool_id}" \
      --display-name="omega VKE" \
      --issuer-uri="${issuer_uri}" \
      --jwk-json-path="${jwks_file}" \
      --allowed-audiences="${provider_audience}" \
      --attribute-mapping="${attribute_mapping}" \
      --attribute-condition="${attribute_condition}" \
      >/dev/null
  else
    gcloud iam workload-identity-pools providers create-oidc "${provider_id}" \
      --project="${project_id}" \
      --location=global \
      --workload-identity-pool="${pool_id}" \
      --display-name="omega VKE" \
      --issuer-uri="${issuer_uri}" \
      --jwk-json-path="${jwks_file}" \
      --allowed-audiences="${provider_audience}" \
      --attribute-mapping="${attribute_mapping}" \
      --attribute-condition="${attribute_condition}" \
      >/dev/null
  fi

  echo "==> ${project_id}: allowing ${namespace}/${ksa_name} to impersonate ${gsa_email}"
  gcloud iam service-accounts add-iam-policy-binding "${gsa_email}" \
    --project="${project_id}" \
    --role=roles/iam.workloadIdentityUser \
    --member="${principal}" \
    --condition=None \
    >/dev/null
done

echo "==> VKE Google Workload Identity Federation bootstrap complete"
