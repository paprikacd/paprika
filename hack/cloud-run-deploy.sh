#!/usr/bin/env bash
set -euo pipefail

# Deploy the Paprika Cloud Run service.
#
# Usage:
#   IMAGE=gcr.io/my-project/paprika-cloud-run:v1 \
#   PAPRIKA_REPO_SERVER_ADDR=https://repo-server.example.com \
#   ./hack/cloud-run-deploy.sh
#
# Environment variables:
#   GCP_PROJECT                  GCP project ID (default: rosy-clover-477102-t5)
#   CLOUD_RUN_SERVICE            Service name (default: paprika-cloud-run)
#   CLOUD_RUN_REGION             Region (default: australia-southeast2)
#   IMAGE                        Full image URI override (default: gcr.io/$GCP_PROJECT/paprika-cloud-run:latest)
#   CONTAINER_TOOL               docker or podman (default: docker)
#   PAPRIKA_REPO_SERVER_ADDR     Direct value for the repo server env var
#   REPO_SERVER_SECRET           Secret Manager secret name for PAPRIKA_REPO_SERVER_ADDR
#   KUBECONFIG_SECRET            Secret Manager secret name mounted as a kubeconfig file
#   KUBECONFIG_MOUNT_PATH        Path where the kubeconfig secret is mounted (default: /secrets/kubeconfig)
#   CLOUD_RUN_SA                 Service account email for the revision
#   CLOUD_RUN_CONCURRENCY        Requests per container (default: 80)
#   CLOUD_RUN_CPU                CPU allocation (default: 2)
#   CLOUD_RUN_MEMORY             Memory allocation (default: 512Mi)
#   CLOUD_RUN_TIMEOUT            Request timeout (default: 300s)
#   CLOUD_RUN_MIN_INSTANCES      Minimum instances (default: 0)
#   CLOUD_RUN_MAX_INSTANCES      Maximum instances (default: 10)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

GCP_PROJECT="${GCP_PROJECT:-rosy-clover-477102-t5}"
CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-paprika-cloud-run}"
CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-australia-southeast2}"
CLOUD_RUN_IMAGE="${IMAGE:-gcr.io/${GCP_PROJECT}/paprika-cloud-run:latest}"
CONTAINER_TOOL="${CONTAINER_TOOL:-docker}"

PAPRIKA_REPO_SERVER_ADDR="${PAPRIKA_REPO_SERVER_ADDR:-}"
REPO_SERVER_SECRET="${REPO_SERVER_SECRET:-}"
KUBECONFIG_SECRET="${KUBECONFIG_SECRET:-}"
KUBECONFIG_MOUNT_PATH="${KUBECONFIG_MOUNT_PATH:-/secrets/kubeconfig}"

CLOUD_RUN_SA="${CLOUD_RUN_SA:-paprika-cloud-run@${GCP_PROJECT}.iam.gserviceaccount.com}"
CLOUD_RUN_CONCURRENCY="${CLOUD_RUN_CONCURRENCY:-80}"
CLOUD_RUN_CPU="${CLOUD_RUN_CPU:-2}"
CLOUD_RUN_MEMORY="${CLOUD_RUN_MEMORY:-512Mi}"
CLOUD_RUN_TIMEOUT="${CLOUD_RUN_TIMEOUT:-300s}"
CLOUD_RUN_MIN_INSTANCES="${CLOUD_RUN_MIN_INSTANCES:-0}"
CLOUD_RUN_MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-10}"

info()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
error() { printf "\033[31mERROR:\033[0m %s\n" "$*" >&2; }

if [ -z "${PAPRIKA_REPO_SERVER_ADDR:-}" ] && [ -z "${REPO_SERVER_SECRET:-}" ]; then
    error "Set PAPRIKA_REPO_SERVER_ADDR or REPO_SERVER_SECRET before deploying"
    exit 1
fi

declare -a ENV_ARGS=()
declare -a SECRET_ARGS=()

if [ -n "${PAPRIKA_REPO_SERVER_ADDR}" ]; then
    ENV_ARGS+=("--set-env-vars=PAPRIKA_REPO_SERVER_ADDR=${PAPRIKA_REPO_SERVER_ADDR}")
fi

if [ -n "${REPO_SERVER_SECRET}" ]; then
    SECRET_ARGS+=("--update-secrets=PAPRIKA_REPO_SERVER_ADDR=${REPO_SERVER_SECRET}:latest")
fi

if [ -n "${KUBECONFIG_SECRET}" ]; then
    SECRET_ARGS+=("--update-secrets=KUBECONFIG=${KUBECONFIG_SECRET}:latest:${KUBECONFIG_MOUNT_PATH}")
fi

info "Building Cloud Run image ${CLOUD_RUN_IMAGE}"
${CONTAINER_TOOL} build -t "${CLOUD_RUN_IMAGE}" -f Dockerfile.cloudrun .

info "Pushing Cloud Run image ${CLOUD_RUN_IMAGE}"
${CONTAINER_TOOL} push "${CLOUD_RUN_IMAGE}"

info "Deploying ${CLOUD_RUN_SERVICE} to ${CLOUD_RUN_REGION}"
CLOUDSDK_CORE_PROJECT="${GCP_PROJECT}" \
CLOUDSDK_CORE_ACCOUNT="${GCP_ACCOUNT:-}" \
gcloud run deploy "${CLOUD_RUN_SERVICE}" \
    --image="${CLOUD_RUN_IMAGE}" \
    --region="${CLOUD_RUN_REGION}" \
    --platform=managed \
    --allow-unauthenticated \
    --service-account="${CLOUD_RUN_SA}" \
    --concurrency="${CLOUD_RUN_CONCURRENCY}" \
    --cpu="${CLOUD_RUN_CPU}" \
    --memory="${CLOUD_RUN_MEMORY}" \
    --timeout="${CLOUD_RUN_TIMEOUT}" \
    --min-instances="${CLOUD_RUN_MIN_INSTANCES}" \
    --max-instances="${CLOUD_RUN_MAX_INSTANCES}" \
    "${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" \
    "${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"}"

info "Deployment complete"
