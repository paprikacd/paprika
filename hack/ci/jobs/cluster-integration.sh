#!/usr/bin/env bash
# Local mirror of the ci.yml job "cluster-integration" (Kind and Helm integration).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init cluster-integration
export GOTOOLCHAIN=auto # ci.yml job env
export IMG=controller:latest # ci.yml job env

# A uniquely named kind cluster per run. Its kubeconfig entry lands in this job's private KUBECONFIG
# file, so the developer's clusters are never read or changed.
CI_CLUSTER="paprika-ci-${PAPRIKA_CI_TREE12:-local}-$$"

# Dump cluster diagnostics on failure (ci.yml: if: failure()).
ci_on_failure() {
  kubectl get pods -A -o wide || true
  kubectl get events -n paprika-system --sort-by=.lastTimestamp || true
  kubectl describe deploy,pods -n paprika-system || true
  kubectl logs -n paprika-system deploy/paprika-controller-manager --tail=80 || true
  kubectl logs -n paprika-system deploy/paprika-controller-manager --tail=80 --previous || true
  kubectl get crd | grep paprika || true
}

# Cleanup kind cluster (ci.yml: if: always()).
ci_cleanup() {
  if [ -n "${CI_CLUSTER:-}" ]; then
    kind delete cluster --name "$CI_CLUSTER" >/dev/null 2>&1 || true
  fi
}

# ci.yml: Checkout / Set up Go / Set up Helm (v3.21.2) -> snapshot and tools.sh.

# ci.yml: Set up Docker Buildx -> the Docker Desktop builder.
docker info >/dev/null 2>&1 || ci_die "Docker is not running; start Docker Desktop"
docker buildx version >/dev/null

# ci.yml: Build manager image (push: false, load: true). CI builds linux/amd64; here the host platform.
docker buildx build --load --tag "$IMG" .

# ci.yml: Install kind (v0.32.0, checksum-verified) -> pinned by hack/ci/tools.sh.

# ci.yml: Create kind cluster (named per run; see CI_CLUSTER above)
kind create cluster --name "$CI_CLUSTER"

# ci.yml: Load manager image
kind load docker-image "$IMG" --name "$CI_CLUSTER"

# ci.yml: Verify split-plane metrics wiring
bash hack/test-split-metrics.sh

# ci.yml: Deploy manager via Helm
make helm-deploy

# ci.yml: Check Helm release status
make helm-status

# ci.yml: Wait for controller-manager
kubectl wait --for=condition=available deployment/paprika-controller-manager -n paprika-system --timeout=120s
