#!/usr/bin/env bash
# Local Paprika perf/profiling environment on kind.
#
# Stands up the full split-mode stack (controller-manager, api-server with
# MCP + auth, repo-server, ui-server, redis) inside a kind cluster, plus
# metrics-server so cluster `used` capacity populates. The api-server is
# reachable on localhost:$PORT with MCP OAuth enabled; pprof is exposed on
# each component for profiling.
#
# Commands:
#   up              create cluster, install metrics-server, build+load image, helm install
#   token           mint an MCP OAuth token into $TOKEN_FILE
#   load [secs]     run hack/mcp-loadgen.sh against the local MCP endpoint (default 60s)
#   profile [secs]  capture pprof CPU/heap/allocs/goroutines (default 30s CPU)
#   metrics         snapshot paprika metrics from all components into $OUT_DIR
#   status          print fleet/cluster health summary via MCP
#   down            delete the kind cluster
#
# Env:
#   KIND_CLUSTER   kind cluster name          (default: paprika-perf)
#   NAMESPACE      deploy namespace           (default: paprika-perf)
#   RELEASE        helm release name          (default: paprika)
#   IMG            local image tag            (default: localhost/paprika-perf:latest)
#   PORT           host port -> api-server    (default: 13100)
#   MGR_PORT       host port -> mgr metrics   (default: 18443)
#   PPROF_PORT     host port -> api-server pprof (default: 16060)
#   TOKEN_FILE     minted token path          (default: /tmp/paprika-perf-token)
#   OUT_DIR        profile/metrics output dir (default: /tmp/paprika-perf)
#   SKIP_BUILD=1   skip docker build+kind load
#   SKIP_METRICS_SERVER=1  skip metrics-server install
set -euo pipefail

KIND_CLUSTER="${KIND_CLUSTER:-paprika-perf}"
NAMESPACE="${NAMESPACE:-paprika-perf}"
RELEASE="${RELEASE:-paprika}"
IMG="${IMG:-localhost/paprika-perf:latest}"
PORT="${PORT:-13100}"
MGR_PORT="${MGR_PORT:-18443}"
API_METRICS_PORT="${API_METRICS_PORT:-18444}"
PPROF_PORT="${PPROF_PORT:-16060}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/paprika-perf-token}"
OUT_DIR="${OUT_DIR:-/tmp/paprika-perf}"
METRICS_SERVER_VERSION="${METRICS_SERVER_VERSION:-v0.8.0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECTL="kubectl --context kind-${KIND_CLUSTER}"

log() { echo "==> $*" >&2; }
die() { echo "error: $*" >&2; exit 1; }

kind_exists() { kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; }

require_cluster() {
  kind_exists || die "kind cluster $KIND_CLUSTER not found — run: $0 up"
}

# issuer_ok reports whether the api-server on localhost:$PORT is this perf
# environment — the OAuth discovery issuer is set to mcp.publicURL at deploy
# time, which pins it to http://localhost:$PORT.
issuer_ok() {
  curl -sf "http://localhost:${PORT}/.well-known/oauth-authorization-server" 2>/dev/null \
    | grep -q "\"issuer\":\"http://localhost:${PORT}\""
}

cmd_up() {
  if ! kind_exists; then
    # kind create switches the global kubectl context to the new cluster —
    # restore the caller's context afterwards so a concurrently running e2e
    # suite or other tooling is not hijacked onto this cluster mid-flight.
    local prev_ctx
    prev_ctx="$(kubectl config current-context 2>/dev/null || true)"
    log "creating kind cluster $KIND_CLUSTER"
    kind create cluster --name "$KIND_CLUSTER"
    if [[ -n "$prev_ctx" && "$prev_ctx" != "kind-$KIND_CLUSTER" ]]; then
      kubectl config use-context "$prev_ctx" >/dev/null
    fi
  else
    log "kind cluster $KIND_CLUSTER already exists"
  fi

  if [[ "${SKIP_METRICS_SERVER:-0}" != "1" ]]; then
    log "installing metrics-server (kind requires --kubelet-insecure-tls)"
    $KUBECTL apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
    $KUBECTL -n kube-system patch deployment metrics-server --type=json -p \
      '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
    $KUBECTL -n kube-system rollout status deployment/metrics-server --timeout=120s
  fi

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    log "building $IMG (native arch for the local kind node)"
    docker build -f "$REPO_ROOT/Dockerfile.fast" -t "$IMG" "$REPO_ROOT"
    log "loading $IMG into kind"
    kind load docker-image "$IMG" --name "$KIND_CLUSTER"
  fi

  log "installing CRDs"
  "$REPO_ROOT/bin/kustomize" build "$REPO_ROOT/config/crd" | $KUBECTL apply --server-side -f -

  log "helm installing $RELEASE (full split stack + MCP + pprof)"
  local repo tag
  repo="${IMG%:*}"; tag="${IMG##*:}"
  helm upgrade --install "$RELEASE" "$REPO_ROOT/charts/chart" \
    --kube-context "kind-$KIND_CLUSTER" \
    --namespace "$NAMESPACE" --create-namespace \
    --set deploymentMode=split \
    --set crd.enable=false \
    --set manager.image.repository="$repo" \
    --set manager.image.tag="$tag" \
    --set manager.image.pullPolicy=Never \
    --set apiServer.image.repository="$repo" \
    --set apiServer.image.tag="$tag" \
    --set apiServer.image.pullPolicy=Never \
    --set apiServer.automountServiceAccountToken=true \
    --set webhookReceiver.automountServiceAccountToken=true \
    --set webhookReceiver.image.repository="$repo" \
    --set webhookReceiver.image.tag="$tag" \
    --set webhookReceiver.image.pullPolicy=Never \
    --set repoServer.image.repository="$repo" \
    --set repoServer.image.tag="$tag" \
    --set repoServer.image.pullPolicy=Never \
    --set metrics.enable=true \
    --set metrics.secure=false \
    --set metrics.bindAddress=:8080 \
    --set 'manager.args[0]=--pprof-bind-address=:6060' \
    --set 'apiServer.args[0]=--pprof-bind-address=:6060' \
    --set apiServer.extraEnv[0].name=PAPRIKA_AUTH_TOKEN_SECRET \
    --set apiServer.extraEnv[0].value=perf-token-secret \
    --set auth.enabled=true \
    --set auth.basic.enabled=true \
    --set auth.basic.username=admin \
    --set 'auth.basic.passwordHash=$2a$10$gokrR1H67p0nl/1Q2k1qk.i9u4iJNm8Iy1PUBR9ScjdhlznxnAKq6' \
    --set 'auth.rbac[0].subjects[0]=*' \
    --set 'auth.rbac[0].actions[0]=*' \
    --set 'auth.rbac[0].resources[0]=*' \
    --set 'auth.rbac[0].namespaces[0]=*' \
    --set mcp.enabled=true \
    --set mcp.oauth.clientId=perf-mcp \
    --set 'mcp.oauth.redirectUris[0]=http://localhost:8791/callback' \
    --set "mcp.publicURL=http://localhost:${PORT}" \
    --wait --timeout 5m

  cat >&2 <<EOF

==> $RELEASE is up on kind cluster $KIND_CLUSTER

Next:
  $0 token                 # mint an MCP OAuth token (admin/admin123)
  $0 load 120              # run MCP loadgen for 120s
  $0 profile 30            # capture pprof profiles -> $OUT_DIR
  $0 metrics               # snapshot paprika_* metrics -> $OUT_DIR
  $0 down                  # tear down

api-server:  http://localhost:${PORT} (after '$0 token' starts the forward)
EOF
}

cmd_token() {
  require_cluster
  # Port-forward api-server if not already up. A bare healthz check is not
  # enough — a stale forward to a different release (e.g. the VKE api-server)
  # would answer it and then reject the perf OAuth client, so verify the
  # issuer in the discovery metadata matches this environment.
  if ! issuer_ok; then
    log "port-forwarding api-server -> localhost:${PORT}"
    local deploy
    deploy=$($KUBECTL -n "$NAMESPACE" get deployment -l app.kubernetes.io/component=api-server -o name | head -1)
    $KUBECTL -n "$NAMESPACE" port-forward "$deploy" "${PORT}:3000" >/dev/null 2>&1 &
    for _ in $(seq 1 30); do issuer_ok && break; sleep 1; done
    issuer_ok || die "api-server on localhost:${PORT} does not report issuer http://localhost:${PORT} — is a stale port-forward bound to the port?"
  fi

  log "minting MCP token (consent -> code -> token)"
  local verifier challenge code token_json
  verifier="$(openssl rand -base64 48 | tr '/+' '_-' | tr -d '=')"
  challenge="$(printf %s "$verifier" | openssl dgst -sha256 -binary | openssl base64 | tr '/+' '_-' | tr -d '=')"

  # The consent response is JSON with & escaped as & — parse it
  # properly rather than regexing the raw body.
  code="$(curl -sf -u 'admin:admin123' -X POST "http://localhost:${PORT}/mcp/authorize/consent" \
    -H 'Content-Type: application/json' \
    -d "{\"client_id\":\"perf-mcp\",\"redirect_uri\":\"http://localhost:8791/callback\",\"code_challenge\":\"${challenge}\",\"code_challenge_method\":\"S256\",\"state\":\"perf\",\"scopes\":[\"paprika:read\",\"paprika:write\"],\"decision\":\"approve\"}" \
    | python3 -c 'import json,sys,urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlparse(json.load(sys.stdin)["redirectTo"]).query)["code"][0])')"
  [[ -n "$code" ]] || die "consent did not return an authorization code"

  token_json="$(curl -sf -X POST "http://localhost:${PORT}/mcp/token" \
    -d "grant_type=authorization_code&code=${code}&code_verifier=${verifier}&client_id=perf-mcp&redirect_uri=http://localhost:8791/callback")"
  echo "$token_json" | grep -q access_token || die "token exchange failed: $token_json"
  echo "$token_json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  log "token written to $TOKEN_FILE"
}

cmd_load() {
  require_cluster
  [[ -f "$TOKEN_FILE" ]] || die "no token — run: $0 token"
  MCP_TOKEN_FILE="$TOKEN_FILE" BASE="http://localhost:${PORT}" \
    "$REPO_ROOT/hack/mcp-loadgen.sh" "${1:-60}"
}

cmd_profile() {
  require_cluster
  local secs="${1:-30}"
  local component="${2:-api}"
  local deploy label
  case "$component" in
    api|api-server)    label="app.kubernetes.io/component=api-server" ;;
    manager|controller) label="control-plane=controller-manager" ;;
    *) die "unknown component '$component' — use api or manager" ;;
  esac
  deploy=$($KUBECTL -n "$NAMESPACE" get deployment -l "$label" -o name | head -1)
  [[ -n "$deploy" ]] || die "no deployment found for component '$component'"

  log "port-forwarding $component pprof -> localhost:${PPROF_PORT}"
  $KUBECTL -n "$NAMESPACE" port-forward "$deploy" "${PPROF_PORT}:6060" >/dev/null 2>&1 &
  local pf=$!
  trap "kill $pf 2>/dev/null || true" EXIT
  for _ in $(seq 1 30); do nc -z localhost "$PPROF_PORT" 2>/dev/null && break; sleep 1; done

  "$REPO_ROOT/hack/pprof-capture.sh" "http://localhost:${PPROF_PORT}" "$secs" \
    "$OUT_DIR/capture-${component}-$(date +%s)"
}

cmd_metrics() {
  require_cluster
  local snap="$OUT_DIR/metrics-$(date +%s)"
  mkdir -p "$snap"

  log "scraping controller-manager metrics -> $snap/manager.txt"
  $KUBECTL -n "$NAMESPACE" port-forward svc/"$RELEASE"-controller-manager-metrics-service \
    "${MGR_PORT}:8443" >/dev/null 2>&1 &
  local pf=$!
  for _ in $(seq 1 30); do nc -z localhost "$MGR_PORT" 2>/dev/null && break; sleep 1; done
  curl -sf "http://localhost:${MGR_PORT}/metrics" -o "$snap/manager.txt" || log "manager scrape failed"
  kill $pf 2>/dev/null || true

  # The api-server serves /metrics on metrics.bindAddress (:8080), not the API
  # port — it is a separate unauthenticated listener.
  log "scraping api-server metrics -> $snap/api-server.txt"
  $KUBECTL -n "$NAMESPACE" port-forward svc/"$RELEASE"-api-server \
    "${API_METRICS_PORT}:8080" >/dev/null 2>&1 &
  pf=$!
  for _ in $(seq 1 30); do nc -z localhost "$API_METRICS_PORT" 2>/dev/null && break; sleep 1; done
  curl -sf "http://localhost:${API_METRICS_PORT}/metrics" -o "$snap/api-server.txt" || log "api-server scrape failed"
  kill $pf 2>/dev/null || true
  # A colliding listener on API_METRICS_PORT answers before our forward binds;
  # Prometheus exposition always starts with "# HELP" comment lines.
  if [[ -f "$snap/api-server.txt" ]] && ! grep -q '^# HELP' "$snap/api-server.txt"; then
    log "WARNING: api-server.txt is not Prometheus output — port ${API_METRICS_PORT} may be bound by another process (override with API_METRICS_PORT)"
  fi

  log "snapshot written to $snap"
  grep -c '^paprika_' "$snap"/*.txt 2>/dev/null || true
}

cmd_status() {
  require_cluster
  [[ -f "$TOKEN_FILE" ]] || die "no token — run: $0 token"
  local token; token="$(cat "$TOKEN_FILE")"
  for tool in fleet_status list_clusters; do
    echo "=== $tool ==="
    curl -sf -X POST "http://localhost:${PORT}/mcp" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":{}}}" \
      | python3 -m json.tool 2>/dev/null || echo "(call failed)"
  done
}

cmd_down() {
  if kind_exists; then
    log "deleting kind cluster $KIND_CLUSTER"
    kind delete cluster --name "$KIND_CLUSTER"
  else
    log "cluster $KIND_CLUSTER does not exist"
  fi
}

case "${1:-}" in
  up)      cmd_up ;;
  token)   cmd_token ;;
  load)    cmd_load "${2:-60}" ;;
  profile) cmd_profile "${2:-30}" ;;
  metrics) cmd_metrics ;;
  status)  cmd_status ;;
  down)    cmd_down ;;
  *)       grep '^#' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
