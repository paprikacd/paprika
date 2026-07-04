#!/usr/bin/env bash
# =============================================================================
# Paprika E2E test harness — Vultr Kubernetes Engine (VKE)
# =============================================================================
# Usage:
#   export VULTR_API_KEY="..."
#   ./hack/e2e-vultr.sh up       # provision cluster + deploy chart
#   ./hack/e2e-vultr.sh test     # run health checks against running cluster
#   ./hack/e2e-vultr.sh down     # tear down cluster
#   ./hack/e2e-vultr.sh ci       # up → test → down (CI mode; tears down on failure)
#
# Prerequisites: vultr-cli, kubectl, helm, curl, jq
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# ── Configurable via environment ──────────────────────────────────────────────
VULTR_API_KEY="${VULTR_API_KEY:-}"
CLUSTER_NAME="${CLUSTER_NAME:-paprika-e2e-$(date +%s)}"
REGION="${REGION:-syd}"
K8S_VERSION="${K8S_VERSION:-}"
NODE_PLAN="${NODE_PLAN:-vc2-2c-4gb}"
NODE_COUNT="${NODE_COUNT:-2}"
CHART="${CHART:-charts/chart}"
RELEASE_NAME="${RELEASE_NAME:-paprika-e2e}"
NAMESPACE="${NAMESPACE:-paprika-e2e}"
TEST_VALUES="${TEST_VALUES:-deploy/test-values.yaml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
TEST_TIMEOUT="${TEST_TIMEOUT:-120}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
CLEANUP_ON_FAILURE="${CLEANUP_ON_FAILURE:-true}"

# Derived
KUBECONFIG="${KUBECONFIG:-${REPO_DIR}/.kubeconfig-${CLUSTER_NAME}}"
PASS=0
FAIL=0

# ── Colors ────────────────────────────────────────────────────────────────────
info()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
pass()  { printf "\033[32m  PASS\033[0m  %s\n" "$*"; ((PASS++)); }
fail()  { printf "\033[31m  FAIL\033[0m  %s\n" "$*" >&2; ((FAIL++)); }
die()   { printf "\033[31mFATAL:\033[0m %s\n" "$*" >&2; exit 1; }

# ── Prerequisites check ───────────────────────────────────────────────────────
check_prereqs() {
    local missing=0
    for cmd in vultr-cli kubectl helm curl jq; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "  MISSING: $cmd"
            ((missing++))
        fi
    done
    if [ "$missing" -gt 0 ]; then
        die "$missing prerequisite(s) missing. Install them and try again."
    fi
    if [ -z "$VULTR_API_KEY" ]; then
        die "VULTR_API_KEY is not set."
    fi
    info "Prerequisites OK"
}

# ── Cluster lifecycle ─────────────────────────────────────────────────────────
cluster_up() {
    if vultr-cli kubernetes list -o json 2>/dev/null | jq -e ".[] | select(.label == \"$CLUSTER_NAME\")" >/dev/null 2>&1; then
        info "Cluster '$CLUSTER_NAME' already exists. Skipping creation."
        cluster_kubeconfig
        return
    fi

    info "Creating VKE cluster '$CLUSTER_NAME' (region=$REGION, plan=$NODE_PLAN, nodes=$NODE_COUNT)..."

    local args=(
        --label "$CLUSTER_NAME"
        --region "$REGION"
        --node-pools "quantity:${NODE_COUNT},plan:${NODE_PLAN},label:${CLUSTER_NAME}-nodes,auto-scaler:false"
    )
    if [ -n "$K8S_VERSION" ]; then
        args+=(--version "$K8S_VERSION")
    fi

    vultr-cli kubernetes create "${args[@]}" -o json >/dev/null || die "Failed to create cluster"

    info "Waiting for cluster to be ready..."
    local cluster_id=""
    for i in $(seq 1 60); do
        cluster_id=$(vultr-cli kubernetes list -o json 2>/dev/null | jq -r ".[] | select(.label == \"$CLUSTER_NAME\") | .id" 2>/dev/null || echo "")
        if [ -n "$cluster_id" ]; then
            local status
            status=$(vultr-cli kubernetes get "$cluster_id" -o json 2>/dev/null | jq -r '.status // "pending"' 2>/dev/null || echo "pending")
            if [ "$status" = "active" ]; then
                info "Cluster ready (ID: $cluster_id)"
                cluster_kubeconfig "$cluster_id"
                return
            fi
        fi
        sleep 10
    done
    die "Cluster not ready within 10 minutes. Aborting."
}

cluster_kubeconfig() {
    local cluster_id="${1:-}"
    if [ -z "$cluster_id" ]; then
        cluster_id=$(vultr-cli kubernetes list -o json 2>/dev/null | jq -r ".[] | select(.label == \"$CLUSTER_NAME\") | .id" 2>/dev/null || echo "")
    fi
    if [ -z "$cluster_id" ]; then
        die "Could not find cluster '$CLUSTER_NAME'"
    fi
    info "Downloading kubeconfig..."
    mkdir -p "$(dirname "$KUBECONFIG")"
    vultr-cli kubernetes config "$cluster_id" > "$KUBECONFIG" 2>/dev/null || die "Failed to get kubeconfig"
    chmod 600 "$KUBECONFIG"
    info "Kubeconfig saved to $KUBECONFIG"
}

cluster_down() {
    local cluster_id
    cluster_id=$(vultr-cli kubernetes list -o json 2>/dev/null | jq -r ".[] | select(.label == \"$CLUSTER_NAME\") | .id" 2>/dev/null || echo "")
    if [ -z "$cluster_id" ]; then
        info "No cluster '$CLUSTER_NAME' found. Nothing to tear down."
        rm -f "$KUBECONFIG"
        return
    fi
    info "Deleting cluster '$CLUSTER_NAME' (ID: $cluster_id)..."
    vultr-cli kubernetes delete "$cluster_id" 2>/dev/null || true
    rm -f "$KUBECONFIG"
    info "Cluster deleted."
}

# ── Helm deployment ───────────────────────────────────────────────────────────
chart_deps() {
    info "Building chart dependencies..."
    helm dependency update "$CHART" 2>/dev/null || true
}

chart_deploy() {
    info "Creating namespace '$NAMESPACE'..."
    kubectl --kubeconfig "$KUBECONFIG" create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f -

    # Load OIDC credentials from .env if present (NEVER commit these to git)
    local set_args=()
    if [ -f "$REPO_DIR/.env" ]; then
        info "Loading credentials from .env..."
        set -a; source "$REPO_DIR/.env"; set +a
        if [ -n "${PAPRIKA_OIDC_CLIENT_ID:-}" ]; then
            set_args+=(--set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID")
        fi
        if [ -n "${PAPRIKA_OIDC_CLIENT_SECRET:-}" ]; then
            set_args+=(--set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET")
        fi
        if [ -n "${PAPRIKA_AUTH_TOKEN_SECRET:-}" ]; then
            set_args+=(--set "auth.tokenSecret=$PAPRIKA_AUTH_TOKEN_SECRET")
        fi
        if [ -n "${PAPRIKA_BASIC_PASSWORD_HASH:-}" ]; then
            set_args+=(--set "auth.basic.passwordHash=$PAPRIKA_BASIC_PASSWORD_HASH")
        fi
    fi

    info "Installing/upgrading Paprika chart..."
    helm upgrade --install "$RELEASE_NAME" "$CHART" \
        --kubeconfig "$KUBECONFIG" \
        --namespace "$NAMESPACE" \
        --values "$TEST_VALUES" \
        "${set_args[@]}" \
        --wait \
        --timeout "${HEALTH_TIMEOUT}s" \
        --create-namespace \
        2>&1 | tee /dev/stderr | grep -q "STATUS: deployed" || die "Helm deploy failed"

    info "Chart deployed successfully."
}

chart_uninstall() {
    info "Uninstalling chart..."
    helm uninstall "$RELEASE_NAME" \
        --kubeconfig "$KUBECONFIG" \
        --namespace "$NAMESPACE" \
        --wait \
        --timeout 120s 2>/dev/null || true
    kubectl --kubeconfig "$KUBECONFIG" delete namespace "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
}

# ── Health checks ─────────────────────────────────────────────────────────────
wait_for_pods() {
    info "Waiting for all Paprika pods to be ready (timeout: ${HEALTH_TIMEOUT}s)..."
    local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        local not_ready
        not_ready=$(kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" get pods -l 'app.kubernetes.io/instance=paprika-e2e' \
            -o json 2>/dev/null | jq '[.items[] | select(.status.phase != "Running" or ([.status.conditions[] | select(.type == "Ready" and .status == "True")] | length) == 0)] | length' 2>/dev/null || echo "1")
        if [ "$not_ready" = "0" ]; then
            info "All pods ready."
            kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" get pods -o wide
            return
        fi
        sleep "$POLL_INTERVAL"
    done
    info "Pods not ready within timeout. Current state:"
    kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" get pods -o wide 2>/dev/null || true
    die "Timed out waiting for pods to be ready."
}

check_endpoint() {
    local desc="$1"
    local url="$2"
    local expected_status="${3:-200}"
    local timeout="${4:-10}"

    if curl -sf -o /dev/null -w "%{http_code}" --max-time "$timeout" "$url" 2>/dev/null | grep -q "$expected_status"; then
        pass "$desc ($url → $expected_status)"
    else
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$timeout" "$url" 2>/dev/null || echo "FAIL")
        fail "$desc ($url → $code, expected $expected_status)"
    fi
}

check_pod_condition() {
    local desc="$1"
    local selector="$2"
    local condition="${3:-Ready=True}"

    local count
    count=$(kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" get pods -l "$selector" \
        -o json 2>/dev/null | jq "[.items[] | select([.status.conditions[] | select(.type == \"${condition%=*}\" and .status == \"${condition#*=}\")] | length > 0)] | length" 2>/dev/null || echo "0")

    local expected
    expected=$(kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" get pods -l "$selector" \
        -o json 2>/dev/null | jq '.items | length' 2>/dev/null || echo "0")

    if [ "$count" -gt 0 ] && [ "$count" -eq "$expected" ]; then
        pass "$desc ($count/$expected pods $condition)"
    else
        fail "$desc ($count/$expected pods $condition)"
    fi
}

run_health_checks() {
    info "Running health checks..."

    # Pod conditions
    check_pod_condition "Controller manager pods Ready" "app.kubernetes.io/component=controller-manager"
    check_pod_condition "API server pods Ready" "app.kubernetes.io/component=api-server"
    check_pod_condition "Webhook receiver pods Ready" "app.kubernetes.io/component=webhook-receiver"
    check_pod_condition "Repo server pods Ready" "app.kubernetes.io/component=repo-server"

    # Service endpoints (via port-forward to avoid LoadBalancer waiting)
    info "Port-forwarding to API server for endpoint checks..."
    kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" port-forward \
        svc/paprika-e2e-paprika-api-server 3000:3000 &
    local PF_PID=$!
    trap "kill $PF_PID 2>/dev/null || true" EXIT
    sleep 3

    # Health endpoint
    check_endpoint "API server health" "http://localhost:3000/healthz" 200
    check_endpoint "API server readyz" "http://localhost:3000/readyz" 200

    # UI serves HTML
    local ui_status
    ui_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:3000/" 2>/dev/null || echo "FAIL")
    if [ "$ui_status" = "200" ]; then
        # Check that it's actually HTML, not a redirect
        local content_type
        content_type=$(curl -s -o /dev/null -w "%{content_type}" --max-time 5 "http://localhost:3000/" 2>/dev/null || echo "")
        if echo "$content_type" | grep -qi "html"; then
            pass "UI serves HTML at /"
        else
            fail "UI at / returned non-HTML content-type: $content_type"
        fi
    else
        fail "UI at / (HTTP $ui_status)"
    fi

    # Metrics endpoints (HTTP since we set secure: false)
    check_endpoint "Controller manager metrics" "http://localhost:3000/metrics" 200

    # Webhook readiness
    check_endpoint "Webhook receiver readiness" "http://localhost:3000/readyz" 200

    # Stop port-forward
    kill "$PF_PID" 2>/dev/null || true
    trap - EXIT

    # Summary
    echo ""
    info "Results: $PASS passed, $FAIL failed"
    if [ "$FAIL" -gt 0 ]; then
        return 1
    fi
}

# ── CI mode: up → test → down ────────────────────────────────────────────────
ci() {
    local exit_code=0
    up
    test || exit_code=$?
    if [ "$CLEANUP_ON_FAILURE" = "true" ] || [ "$exit_code" = "0" ]; then
        down
    else
        info "Skipping teardown (CLEANUP_ON_FAILURE=false). Cluster '$CLUSTER_NAME' is left running."
    fi
    exit "$exit_code"
}

# ── Subcommands ───────────────────────────────────────────────────────────────
up() {
    check_prereqs
    cluster_up
    chart_deps
    chart_deploy
    wait_for_pods
    info "Deployment complete. Run '$0 test' or '$0 down'."
}

test() {
    if [ ! -f "$KUBECONFIG" ]; then
        die "Kubeconfig not found at $KUBECONFIG. Run '$0 up' first."
    fi
    run_health_checks
    if [ "$FAIL" -gt 0 ]; then
        info "Some checks failed."
        return 1
    fi
    info "All checks passed."
}

down() {
    chart_uninstall
    cluster_down
    info "Cleanup complete."
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-help}" in
    up)         up ;;
    down)       down ;;
    test)       test ;;
    ci)         ci ;;
    *)
        echo "Usage: $0 {up|down|test|ci}"
        echo ""
        echo "  up      — provision VKE cluster + deploy Paprika chart"
        echo "  down    — uninstall chart + delete VKE cluster"
        echo "  test    — run health checks against running cluster"
        echo "  ci      — up → test → down (full pipeline)"
        echo ""
        echo "Environment variables:"
        echo "  VULTR_API_KEY   (required)"
        echo "  CLUSTER_NAME    (default: paprika-e2e-<timestamp>)"
        echo "  REGION          (default: syd)"
        echo "  NODE_PLAN       (default: vc2-2c-4gb)"
        echo "  NODE_COUNT      (default: 2)"
        exit 0
        ;;
esac
