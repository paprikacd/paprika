#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kubeconfig="${KUBECONFIG:-${root_dir}/terraform/omega.kubeconfig}"
namespace="${PAPRIKA_NAMESPACE:-paprika-e2e}"
pool_id="${WIF_POOL_ID:-vke-omega}"
provider_id="${WIF_PROVIDER_ID:-omega}"

checks=(
  "brandbrain-486909|brandbrain-api-release|brandbrain-backend@brandbrain-486909.iam.gserviceaccount.com|gcloud storage buckets describe gs://brandbrain-486909-brandbrain-logos --format=value\\(name\\)"
  "cuttlefish-d16cd|cuttlefish-controlplane-release|cf-controlplane@cuttlefish-d16cd.iam.gserviceaccount.com|gcloud storage buckets list --project=cuttlefish-d16cd --limit=1 --format=value\\(name\\)"
  "flaggr-478302|flaggr-api-release|flaggr-grpc-sa@flaggr-478302.iam.gserviceaccount.com|gcloud auth print-access-token --quiet >/dev/null && echo token-ok"
  "uptime-485903|telesis-api-release|telesis-vke-runtime@uptime-485903.iam.gserviceaccount.com|gcloud pubsub topics list --project=uptime-485903 --limit=1 --format=value\\(name\\)"
)

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

echo "==> Validating VKE to GCP Workload Identity Federation"
for item in "${checks[@]}"; do
  IFS='|' read -r project_id ksa_name gsa_email check_cmd <<<"${item}"
  project_number="$(gcloud projects describe "${project_id}" --format='value(projectNumber)')"
  provider_resource="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${provider_id}"
  token_audience="//iam.googleapis.com/${provider_resource}"
  token_file="${tmp_dir}/${project_id}.token"
  cred_file="${tmp_dir}/${project_id}.json"
  gcloud_config="${tmp_dir}/${project_id}-gcloud"

  mkdir -p "${gcloud_config}"
  kubectl --kubeconfig="${kubeconfig}" -n "${namespace}" create token "${ksa_name}" \
    --audience="${token_audience}" \
    --duration=10m \
    >"${token_file}"
  gcloud iam workload-identity-pools create-cred-config "${provider_resource}" \
    --service-account="${gsa_email}" \
    --credential-source-file="${token_file}" \
    --output-file="${cred_file}" \
    >/dev/null
  CLOUDSDK_CONFIG="${gcloud_config}" gcloud auth login --cred-file="${cred_file}" --brief >/dev/null

  echo "ok ${project_id} ${namespace}/${ksa_name} -> ${gsa_email}"
  CLOUDSDK_CONFIG="${gcloud_config}" bash -lc "${check_cmd}" >/dev/null
done

echo "==> VKE to GCP Workload Identity Federation validation passed"
