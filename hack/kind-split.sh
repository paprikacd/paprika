#!/usr/bin/env bash
set -euo pipefail
# Split-plane dev environment with Kind.
#
#   ./hack/kind-split.sh up      # create Kind + deploy operator + start cloud-run
#   ./hack/kind-split.sh down    # clean up cloud-run + Kind cluster
#   ./hack/kind-split.sh restart # rebuild cloud-run binary and restart it
#
# The operator (controllers + webhooks) runs inside Kind.
# The cloud-run binary (API + repo server + UI + webhook receiver)
# runs on the host and talks to Kind's API server from outside.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

CLUSTER_NAME="${KIND_CLUSTER_NAME:-paprika-split}"
MANAGER_IMAGE="${MANAGER_IMAGE:-paprika-split-manager:latest}"
CLOUD_RUN_PORT="${CLOUD_RUN_PORT:-8080}"
CLOUD_RUN_PROBE_PORT="${CLOUD_RUN_PROBE_PORT:-8081}"
CLOUD_RUN_PID_FILE="${CLOUD_RUN_PID_FILE:-/tmp/paprika-cloud-run.pid}"
NAMESPACE="${NAMESPACE:-paprika-system}"

info()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
error() { printf "\033[31mERROR:\033[0m %s\n" "$*" >&2; }

cleanup() {
    if [ -f "$CLOUD_RUN_PID_FILE" ]; then
        pid=$(cat "$CLOUD_RUN_PID_FILE")
        info "Stopping cloud-run (pid $pid)..."
        kill "$pid" 2>/dev/null || true
        rm -f "$CLOUD_RUN_PID_FILE"
    fi
}

up() {
    ensure_kind_cluster
    build_load_manager
    deploy_manager
    start_cloud_run
}

down() {
    cleanup
    info "Deleting Kind cluster '$CLUSTER_NAME'..."
    kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
    info "Done"
}

restart() {
    cleanup
    start_cloud_run
}

# ── helpers ──────────────────────────────────────────────────────────

ensure_kind_cluster() {
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        info "Kind cluster '$CLUSTER_NAME' already exists"
        return
    fi
    info "Creating Kind cluster '$CLUSTER_NAME'..."
    kind create cluster --name "$CLUSTER_NAME"
}

build_load_manager() {
    info "Building manager image..."
    docker build -t "$MANAGER_IMAGE" -f Dockerfile .
    info "Loading manager image into Kind..."
    kind load docker-image "$MANAGER_IMAGE" --name "$CLUSTER_NAME"
}

deploy_manager() {
    info "Deploying CRDs and manager..."
    # Install CRDs first
    kubectl apply --context "kind-${CLUSTER_NAME}" -f config/crd/bases/ 2>/dev/null || true

    # Deploy the manager via Kustomize, patching in the image we built
    cd config/manager && kustomize edit set image controller="${MANAGER_IMAGE}"
    cd "$REPO_DIR"
    kustomize build config/default | kubectl apply --context "kind-${CLUSTER_NAME}" -f - 2>/dev/null || true

    info "Waiting for manager deployment to be ready..."
    kubectl --context "kind-${CLUSTER_NAME}" -n "$NAMESPACE" wait \
        --for=condition=Available deployment/paprika-controller-manager \
        --timeout=120s 2>/dev/null || true
}

start_cloud_run() {
    info "Building cloud-run binary..."
    go build -o /tmp/paprika-cloud-run ./cmd/cloud-run/

    # Kind's kubeconfig context is kind-<cluster-name>
    info "Starting cloud-run binary (port $CLOUD_RUN_PORT)..."
    /tmp/paprika-cloud-run \
        --kubeconfig="$(kind get kubeconfig --name "$CLUSTER_NAME" --internal 2>/dev/null || echo "")" \
        --health-probe-bind-address=":${CLOUD_RUN_PROBE_PORT}" \
        --work-dir="/tmp/paprika-cloudrun-work" \
        &
    echo $! > "$CLOUD_RUN_PID_FILE"

    # Wait for the server to be ready
    sleep 2
    if curl -s "http://localhost:${CLOUD_RUN_PORT}/healthz" >/dev/null 2>&1; then
        info "Cloud Run server is ready at http://localhost:${CLOUD_RUN_PORT}"
    else
        error "Cloud Run server failed to start. Check logs."
        cleanup
        return 1
    fi
}

# ── dispatch ─────────────────────────────────────────────────────────

case "${1:-up}" in
    up)      up ;;
    down)    down ;;
    restart) restart ;;
    *)
        echo "Usage: $0 {up|down|restart}"
        exit 1
        ;;
esac
