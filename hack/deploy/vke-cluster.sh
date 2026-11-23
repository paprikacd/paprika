#!/usr/bin/env bash
# Cluster phase of task deploy: the deploy-vke.yml steps from "Verify cluster access" through the health
# checks, then verification and the report. hack/deploy/vke.sh runs this file from the commit's own worktree,
# under ci_with_timeout with the 20-minute limit of deploy-vke.yml. It reads the PAPRIKA_DEPLOY_* variables that
# vke.sh exports, and it never prints a secret value.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../ci/lib.sh"

readonly VKE_NAMESPACE=paprika-e2e
readonly HELM_RELEASE=paprika-e2e
readonly HELM_CHART=charts/chart
readonly TEST_VALUES=deploy/test-values.yaml
readonly OMEGA_VALUES=deploy/omega-values.yaml
readonly INSIGHTS_VALUES=deploy/insights-omega-values.yaml
readonly PAPRIKA_IMAGE_REPO=ghcr.io/paprikacd/paprika

deploy_log() { ci_log "deploy: $*"; }
deploy_die() { ci_die "deploy: $*"; }

[ "$#" -eq 0 ] || deploy_die "the cluster phase takes no arguments (got: $*)"
for name in PAPRIKA_DEPLOY_WORK PAPRIKA_DEPLOY_KUBECONFIG PAPRIKA_DEPLOY_COMMIT PAPRIKA_DEPLOY_TREE \
  PAPRIKA_DEPLOY_REPORT_DIR PAPRIKA_DEPLOY_PAPRIKA_REF PAPRIKA_DEPLOY_PAPRIKA_DIGEST \
  PAPRIKA_DEPLOY_RENDER_REF PAPRIKA_DEPLOY_RENDER_DIGEST; do
  [ -n "${!name:-}" ] || deploy_die "$name is not set; run the cluster phase through hack/deploy/vke.sh"
done
work=$PAPRIKA_DEPLOY_WORK
kubeconfig=$PAPRIKA_DEPLOY_KUBECONFIG
commit=$PAPRIKA_DEPLOY_COMMIT
tree=$PAPRIKA_DEPLOY_TREE
paprika_ref=$PAPRIKA_DEPLOY_PAPRIKA_REF
paprika_digest=$PAPRIKA_DEPLOY_PAPRIKA_DIGEST
render_ref=$PAPRIKA_DEPLOY_RENDER_REF
render_digest=$PAPRIKA_DEPLOY_RENDER_DIGEST
helm_bin="$CI_TOOL_BIN/helm"
export KUBECONFIG="$kubeconfig"
k() { kubectl --kubeconfig "$kubeconfig" "$@"; }
h() { "$helm_bin" --kubeconfig "$kubeconfig" "$@"; }

# The helper scripts below (shared with deploy-vke.yml) call kubectl without naming a kubeconfig. They run with
# a kubectl shim first on PATH, which names the deploy kubeconfig on every call. The shim is removed with $work.
shim_dir="$work/kubectl-shim"
mkdir -p "$shim_dir"
real_kubectl=$(command -v kubectl)
printf '#!/usr/bin/env bash\nexec "%s" --kubeconfig "%s" "$@"\n' "$real_kubectl" "$kubeconfig" >"$shim_dir/kubectl"
chmod 0700 "$shim_dir/kubectl"
helper_path="$shim_dir:$PATH"

# The port-forward is stopped on every exit, including the stop that ci_with_timeout sends on the limit.
pf_pid=""
cleanup() {
  trap - EXIT
  if [ -n "$pf_pid" ]; then
    ci_kill_tree "$pf_pid"
    wait "$pf_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'ci_stop_children; exit 143' TERM
trap 'ci_stop_children; exit 130' INT HUP

cd "$CI_REPO_ROOT" || deploy_die "cannot enter $CI_REPO_ROOT"
rollout_started=$SECONDS

# deploy-vke.yml: "Verify cluster access"
k get nodes >/dev/null || deploy_die "cannot list nodes on the VKE cluster"
k get namespace "$VKE_NAMESPACE" >/dev/null || deploy_die "namespace $VKE_NAMESPACE is missing"

# deploy-vke.yml: "Verify retained Insights storage". Omega's saved queries and dashboards live on this
# existing claim; stop before any release change.
pvc_phase=$(k -n "$VKE_NAMESPACE" get pvc paprika-e2e-insights -o 'jsonpath={.status.phase}' 2>/dev/null || true)
[ "$pvc_phase" = Bound ] || deploy_die "Omega Insights requires its retained paprika-e2e-insights PVC to be Bound (found: ${pvc_phase:-none})"

# Auth values. Taken from the environment when set, else from the live release. Never printed.
client_id=${VKE_OIDC_CLIENT_ID:-}
password_hash=${VKE_BASIC_PASSWORD_HASH:-}
if [ -z "$client_id" ] || [ -z "$password_hash" ]; then
  current_values=$(h get values "$HELM_RELEASE" -n "$VKE_NAMESPACE" -o json 2>/dev/null || true)
  if [ -z "$client_id" ]; then
    client_id=$(jq -r '.auth.oidc.clientID // empty' <<<"$current_values" 2>/dev/null || true)
  fi
  if [ -z "$password_hash" ]; then
    password_hash=$(jq -r '.auth.basic.passwordHash // empty' <<<"$current_values" 2>/dev/null || true)
  fi
  unset current_values
fi
[ -n "$client_id" ] || deploy_die "auth.oidc.clientID is unknown: set VKE_OIDC_CLIENT_ID or deploy once with it set"
[ -n "$password_hash" ] || deploy_die "auth.basic.passwordHash is unknown: set VKE_BASIC_PASSWORD_HASH or deploy once with it set"

# Existing Secrets are reused. They are rewritten only when the matching variable is set, using the same
# commands as deploy-vke.yml. The Secret values travel on stdin, never on argv.
secret_exists() { k -n "$VKE_NAMESPACE" get secret "$1" -o name >/dev/null 2>&1; }
apply_secret() { # name key value
  local name=$1 key=$2 value=$3 result
  # Only stdout is the result, as in deploy-vke.yml: kubectl warnings (on stderr) go to the log, not into the comparison.
  result=$(printf '%s' "$value" | k -n "$VKE_NAMESPACE" create secret generic "$name" \
    --from-file="$key=/dev/stdin" --dry-run=client -o yaml | k apply -f -) ||
    deploy_die "failed to apply Secret $name"
  case "$result" in
    "secret/$name created" | "secret/$name configured" | "secret/$name unchanged")
      deploy_log "Secret $name: ${result#secret/"$name" }"
      ;;
    *) deploy_die "unexpected result applying Secret $name" ;;
  esac
}

# deploy-vke.yml: "Deploy Paprika chart". The renderer values come first and the Secrets second, in the
# same order as deploy-vke.yml. The loopback secret for the renderer never leaves Kubernetes.
PATH="$helper_path" bash hack/prepare-dashboard-renderer.sh "$VKE_NAMESPACE" "$HELM_RELEASE" \
  "$render_ref" "$work/renderer-values.json" >&2 || deploy_die "dashboard renderer preparation failed"
secret_exists paprika-oidc || deploy_die "Secret paprika-oidc does not exist in $VKE_NAMESPACE; create it first"
secret_exists paprika-auth-token || deploy_die "Secret paprika-auth-token does not exist in $VKE_NAMESPACE; create it first"
if [ -n "${VKE_OIDC_CLIENT_SECRET:-}" ]; then
  apply_secret paprika-oidc client-secret "$VKE_OIDC_CLIENT_SECRET"
fi
if [ -n "${VKE_AUTH_TOKEN_SECRET:-}" ]; then
  apply_secret paprika-auth-token token-secret "$VKE_AUTH_TOKEN_SECRET"
fi

# The auth values go in a 0600 values file, not on argv where ps could show them. The values reach jq through
# its environment, which is not part of the argv of any process.
(
  umask 077
  PAPRIKA_AUTH_CLIENT_ID="$client_id" PAPRIKA_AUTH_PASSWORD_HASH="$password_hash" jq -n '{
    auth: {
      oidc: {clientID: $ENV.PAPRIKA_AUTH_CLIENT_ID, existingSecretName: "paprika-oidc", existingSecretKey: "client-secret"},
      basic: {passwordHash: $ENV.PAPRIKA_AUTH_PASSWORD_HASH}
    }
  }' >"$work/auth-values.json"
)
unset client_id password_hash

deploy_log "helm upgrade --install $HELM_RELEASE --namespace $VKE_NAMESPACE (timeout 5m)"
h upgrade --install "$HELM_RELEASE" "$HELM_CHART" \
  --namespace "$VKE_NAMESPACE" \
  --values "$TEST_VALUES" \
  --values "$OMEGA_VALUES" \
  --values "$INSIGHTS_VALUES" \
  --values "$work/renderer-values.json" \
  --values "$work/auth-values.json" \
  --set-string "manager.image.repository=$paprika_ref" \
  --set-string "apiServer.image.repository=$paprika_ref" \
  --set-string "repoServer.image.repository=$paprika_ref" \
  --set-string "webhookReceiver.image.repository=$paprika_ref" \
  --set-string "observabilityGateway.image.repository=$paprika_ref" \
  --set-string auth.oidc.existingSecretName=paprika-oidc \
  --set-string auth.oidc.existingSecretKey=client-secret \
  --wait \
  --timeout 5m \
  --create-namespace >&2 || deploy_die "helm upgrade failed"

h status "$HELM_RELEASE" --namespace "$VKE_NAMESPACE" >&2 || deploy_die "helm status failed"

# deploy-vke.yml: "Wait for all pods ready". A pod the kubelet evicted stays listed as Succeeded or Failed;
# it is history, not rollout.
k wait --for=condition=Ready pods \
  -l "app.kubernetes.io/instance=$HELM_RELEASE" \
  --field-selector=status.phase!=Succeeded,status.phase!=Failed \
  -n "$VKE_NAMESPACE" --timeout=180s >&2 || deploy_die "pods were not Ready within 180s"
k get pods -n "$VKE_NAMESPACE" -o wide >&2

# deploy-vke.yml: "Verify dashboard renderer" (timeout-minutes: 2)
render_enabled=false
if jq -e '.observabilityGateway.renderWorker.enabled' "$work/renderer-values.json" >/dev/null; then
  render_enabled=true
  PATH="$helper_path" ci_with_timeout 120 bash hack/check-dashboard-renderer-health.sh "$VKE_NAMESPACE" "$HELM_RELEASE" >&2 ||
    deploy_die "dashboard renderer health check failed"
fi

# deploy-vke.yml: "Check pod conditions"
env VKE_NAMESPACE="$VKE_NAMESPACE" HELM_RELEASE="$HELM_RELEASE" PATH="$helper_path" \
  bash hack/check-vke-pod-conditions.sh >&2 || deploy_die "pod conditions check failed"

# deploy-vke.yml: "Health check via port-forward", on a free local port (never 3000). kubectl is backgrounded
# directly, not through the k function, so that $! is the kubectl process and cleanup stops it.
port=$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')
kubectl --kubeconfig "$kubeconfig" -n "$VKE_NAMESPACE" port-forward "svc/$HELM_RELEASE-api-server" "$port:3000" \
  >/dev/null 2>&1 &
pf_pid=$!
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$pf_pid" 2>/dev/null || deploy_die "port-forward exited before the health checks"
  sleep 1
done
[ "$ready" = 1 ] || deploy_die "api-server did not answer /healthz through the port-forward"

health_pass=0
health_fail=0
check_status() { # description path expected
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port$2" 2>/dev/null) || code=FAIL
  if [ "$code" = "$3" ]; then
    deploy_log "PASS $1 ($2 -> $3)"
    health_pass=$((health_pass + 1))
  else
    deploy_log "FAIL $1 ($2 -> ${code:-none}, expected $3)"
    health_fail=$((health_fail + 1))
  fi
}
check_status "health endpoint" /healthz 200
check_status "readiness endpoint" /readyz 200
ui_type=$(curl -s -o /dev/null -w '%{content_type}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null || true)
ui_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null || true)
if [ "$ui_code" = 200 ] && grep -qi html <<<"$ui_type"; then
  deploy_log "PASS UI serves HTML at /"
  health_pass=$((health_pass + 1))
else
  deploy_log "FAIL UI at / (HTTP ${ui_code:-none}, content type ${ui_type:-none})"
  health_fail=$((health_fail + 1))
fi
check_status "metrics endpoint" /metrics 200
ci_kill_tree "$pf_pid"
wait "$pf_pid" 2>/dev/null || true
pf_pid=""
deploy_log "health checks: $health_pass passed, $health_fail failed"
[ "$health_fail" = 0 ] || deploy_die "health checks failed"

# Verification. Every running Paprika container must report the digest that was pushed.
pods_json=$(k get pods -n "$VKE_NAMESPACE" -l "app.kubernetes.io/instance=$HELM_RELEASE" -o json)
digest_check=$(jq -c \
  --arg prefix "$PAPRIKA_IMAGE_REPO" --arg rprefix "ghcr.io/paprikacd/paprika-render-worker" \
  --arg pdigest "$paprika_digest" --arg rdigest "$render_digest" '
  [ .items[] | select(.status.phase == "Running" and .metadata.deletionTimestamp == null) as $pod
    | ($pod.status.containerStatuses // [])[]
    # containerd can report .image as the bare config ID (sha256:...), so the repository is read from
    # imageID (repo@digest, with an optional runtime scheme). .image is the fallback when imageID has no digest.
    | ((.imageID // "") | sub("^[a-z-]+://"; "")) as $id
    | ((if ($id | contains("@")) then $id else (.image // "") end) | split("@")[0] | sub(":[^/:]*$"; "")) as $repo
    | select($repo == $prefix or $repo == $rprefix)
    | if $repo == $rprefix
      then {ok: ($id | contains($rdigest)), kind: "render-worker"}
      else {ok: ($id | contains($pdigest)), kind: "paprika"}
      end
  ] | {
    checked: length,
    mismatched: ([.[] | select(.ok | not)] | length),
    renderers: ([.[] | select(.kind == "render-worker")] | length)
  }' <<<"$pods_json")
checked=$(jq -r '.checked' <<<"$digest_check")
mismatched=$(jq -r '.mismatched' <<<"$digest_check")
[ "$checked" -gt 0 ] || deploy_die "no running Paprika containers were found"
[ "$mismatched" = 0 ] || deploy_die "$mismatched running container(s) do not report the pushed digest"
if [ "$render_enabled" = true ]; then
  renderers=$(jq -r '.renderers' <<<"$digest_check")
  [ "$renderers" -gt 0 ] || deploy_die "the dashboard renderer is enabled but no running render-worker container was found"
fi
deploy_log "image digests: $checked running container(s) report the pushed digest"

history_json=$(h history "$HELM_RELEASE" -n "$VKE_NAMESPACE" -o json)
revision=$(jq -r 'last | .revision' <<<"$history_json")
release_status=$(jq -r 'last | .status' <<<"$history_json")
[ "$release_status" = deployed ] || deploy_die "Helm reports status $release_status for revision $revision"
deploy_log "Helm revision $revision is deployed"

# Error and warn counts over the rollout window. Reported only; they never fail the deploy.
since=$((SECONDS - rollout_started + 30))
log_counts='{}'
for component in api-server observability-gateway insights; do
  count=$(k logs "deploy/$HELM_RELEASE-$component" -n "$VKE_NAMESPACE" --since="${since}s" 2>/dev/null |
    grep -ciE '"level":"(error|warn)"|level=(error|warn)' || true)
  count=${count:-0}
  deploy_log "log lines at error or warn since rollout: $component = $count (report only)"
  log_counts=$(jq -c --arg c "$component" --argjson n "$count" '. + {($c): $n}' <<<"$log_counts")
done

# Report. Contains no secrets. It is written to the developer checkout's artifacts directory, never the worktree.
mkdir -p -- "$PAPRIKA_DEPLOY_REPORT_DIR"
out="$PAPRIKA_DEPLOY_REPORT_DIR/${commit:0:12}.json"
jq -n \
  --arg commit "$commit" --arg tree "$tree" --arg namespace "$VKE_NAMESPACE" --arg release "$HELM_RELEASE" \
  --arg paprika "$paprika_ref" --arg render "$render_ref" --argjson renderEnabled "$render_enabled" \
  --argjson revision "$revision" --arg status "$release_status" \
  --argjson checked "$checked" --argjson health_pass "$health_pass" --argjson health_fail "$health_fail" \
  --argjson logs "$log_counts" --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
    commit: $commit, tree: $tree, namespace: $namespace, release: $release,
    images: {paprika: $paprika, renderWorker: (if $renderEnabled then $render else null end)},
    helm: {revision: $revision, status: $status},
    verification: {
      runningContainersChecked: $checked,
      healthChecks: {passed: $health_pass, failed: $health_fail},
      errorWarnLogLines: $logs
    },
    finishedAt: $finishedAt
  }' >"$out"
deploy_log "cluster phase finished: revision $revision; report written"
