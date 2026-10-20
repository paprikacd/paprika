#!/usr/bin/env bash
set -euo pipefail
# Three-cluster fleet rig for multi-cluster and satellite work.
#
#   ./hack/fleet-rig.sh up       # create clusters, install Paprika, register remotes, run a satellite
#   ./hack/fleet-rig.sh status   # clusters, link state, placements, rollouts
#   ./hack/fleet-rig.sh seed     # dispatch a sample bundle through the internal listener
#   ./hack/fleet-rig.sh down     # delete only this rig's clusters
#
# Topology: one management cluster running Paprika in monolith mode, two
# `direct` registrations reached over the shared kind Docker network, and one
# `agent` registration served by a satellite running inside the management
# cluster itself. The satellite reaches the control plane over loopback
# (hostNetwork + NodePort), which is the one cleartext endpoint the link
# accepts.
#
# Test-only choices, deliberately not chart defaults:
#   * the satellite ServiceAccount is bound to cluster-admin because it applies
#     whatever bundle the control plane renders;
#   * the internal dispatch listener is enabled with a fixed test token so
#     `seed` can exercise the same route split mode uses.
#
# Everything here is scoped to the three `fleet-*` clusters. The perf and e2e
# clusters are never touched.

MGMT_CLUSTER="${FLEET_MGMT_CLUSTER:-fleet-mgmt}"
EU_CLUSTER="${FLEET_EU_CLUSTER:-fleet-eu}"
US_CLUSTER="${FLEET_US_CLUSTER:-fleet-us}"
NAMESPACE="${FLEET_NAMESPACE:-paprika-system}"
SAT_NAMESPACE="${FLEET_SATELLITE_NAMESPACE:-paprika-satellite}"
APP_NAMESPACE="${FLEET_APP_NAMESPACE:-checkout}"
RELEASE="${FLEET_RELEASE:-paprika}"
IMAGE="${FLEET_IMG:-paprika-local:fleet-rig}"
IMAGE_REPO="${IMAGE%:*}"
IMAGE_TAG="${IMAGE##*:}"
NODE_PORT="${FLEET_NODE_PORT:-31300}"
INTERNAL_TOKEN="${FLEET_INTERNAL_TOKEN:-fleet-internal-token-not-for-production}"
SATELLITE_TOKEN="${FLEET_SATELLITE_TOKEN:-fleet-satellite-token-not-for-production}"

MGMT_CTX="kind-${MGMT_CLUSTER}"
EU_CTX="kind-${EU_CLUSTER}"
US_CTX="kind-${US_CLUSTER}"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

require() {
  for bin in kind helm kubectl docker; do
    command -v "$bin" >/dev/null 2>&1 || {
      printf 'missing required command: %s\n' "$bin" >&2
      exit 1
    }
  done
}

cluster_exists() {
  kind get clusters 2>/dev/null | grep -qx "$1"
}

create_cluster() {
  local name=$1
  if cluster_exists "$name"; then
    info "kind cluster ${name} already exists"
    return
  fi
  local prev_ctx
  prev_ctx="$(kubectl config current-context 2>/dev/null || true)"
  info "creating kind cluster ${name}"
  kind create cluster --name "$name" --wait 120s >/dev/null
  if [ -n "$prev_ctx" ] && [ "$prev_ctx" != "kind-${name}" ]; then
    kubectl config use-context "$prev_ctx" >/dev/null
  fi
}

up() {
  require
  create_cluster "$MGMT_CLUSTER"
  create_cluster "$EU_CLUSTER"
  create_cluster "$US_CLUSTER"

  info "building ${IMAGE} for the node's architecture"
  docker build -f Dockerfile.fast -t "$IMAGE" . >/dev/null
  kind load docker-image "$IMAGE" --name "$MGMT_CLUSTER" >/dev/null

  kubectl --context "$MGMT_CTX" create namespace "$NAMESPACE" --dry-run=client -o yaml |
    kubectl --context "$MGMT_CTX" apply -f - >/dev/null
  kubectl --context "$MGMT_CTX" -n "$NAMESPACE" create secret generic paprika-fleet-internal \
    --from-literal=token="$INTERNAL_TOKEN" --dry-run=client -o yaml |
    kubectl --context "$MGMT_CTX" apply -f - >/dev/null

  info "installing ${RELEASE} (monolith) with the internal dispatch listener"
  helm upgrade --install "$RELEASE" charts/chart/ \
    --kube-context "$MGMT_CTX" \
    --namespace "$NAMESPACE" \
    --set deploymentMode=monolith \
    --set "manager.image.repository=${IMAGE_REPO}" \
    --set "manager.image.tag=${IMAGE_TAG}" \
    --set metrics.secure=false \
    --set-json 'manager.args=["--internal-bind-address=:8082","--internal-token-file=/etc/paprika-fleet/token"]' \
    --set-json 'manager.extraVolumes=[{"name":"fleet-internal","secret":{"secretName":"paprika-fleet-internal"}}]' \
    --set-json 'manager.extraVolumeMounts=[{"name":"fleet-internal","mountPath":"/etc/paprika-fleet","readOnly":true}]' \
    --wait --timeout 5m >/dev/null
  kubectl --context "$MGMT_CTX" -n "$NAMESPACE" rollout status \
    "deployment/${RELEASE}-controller-manager" --timeout=240s >/dev/null

  for pair in "${EU_CLUSTER}:${EU_CTX}:eu-west:production" "${US_CLUSTER}:${US_CTX}:us-east:staging"; do
    local name ctx region tier
    IFS=: read -r name ctx region tier <<<"$pair"
    info "registering ${name} (direct)"
    kind get kubeconfig --internal --name "$name" >"/tmp/fleet-${name}.kubeconfig"
    kubectl --context "$MGMT_CTX" -n "$NAMESPACE" create secret generic "${name}-kubeconfig" \
      --from-file=kubeconfig="/tmp/fleet-${name}.kubeconfig" --dry-run=client -o yaml |
      kubectl --context "$MGMT_CTX" apply -f - >/dev/null
    cat <<EOF | kubectl --context "$MGMT_CTX" apply -f - >/dev/null
apiVersion: clusters.paprika.io/v1alpha1
kind: Cluster
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
spec:
  displayName: ${name}
  mode: direct
  server: https://${name}-control-plane:6443
  labels:
    region: ${region}
    tier: ${tier}
  kubeconfigSecretRef:
    name: ${name}-kubeconfig
    key: kubeconfig
EOF
    kubectl --context "$ctx" create namespace "$APP_NAMESPACE" --dry-run=client -o yaml |
      kubectl --context "$ctx" apply -f - >/dev/null
  done
  kubectl --context "$MGMT_CTX" create namespace "$APP_NAMESPACE" --dry-run=client -o yaml |
    kubectl --context "$MGMT_CTX" apply -f - >/dev/null

  info "installing the satellite (agent registration)"
  kubectl --context "$MGMT_CTX" create namespace "$SAT_NAMESPACE" --dry-run=client -o yaml |
    kubectl --context "$MGMT_CTX" apply -f - >/dev/null
  # The control plane only accepts a credential whose Secret carries this
  # label: it is what binds a Secret to the registration it authorises, so a
  # Secret copied from another cluster cannot be presented for this one.
  cat <<EOF | kubectl --context "$MGMT_CTX" apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: mgmt-satellite-satellite-token
  namespace: ${NAMESPACE}
  labels:
    paprika.io/satellite-cluster: mgmt-satellite
stringData:
  token: ${SATELLITE_TOKEN}
EOF
  kubectl --context "$MGMT_CTX" -n "$SAT_NAMESPACE" create secret generic mgmt-satellite-token \
    --from-literal=token="$SATELLITE_TOKEN" --dry-run=client -o yaml |
    kubectl --context "$MGMT_CTX" apply -f - >/dev/null

  cat <<EOF | kubectl --context "$MGMT_CTX" apply -f - >/dev/null
apiVersion: v1
kind: Service
metadata:
  name: paprika-satellite-control
  namespace: ${NAMESPACE}
spec:
  type: NodePort
  selector:
    control-plane: controller-manager
  ports:
    # The satellite speaks the public link protocol, so this points at the API
    # listener (:3000), not the internal dispatch port. A satellite reaches it
    # through the node's loopback because it runs with hostNetwork.
    - name: api
      port: 3000
      targetPort: 3000
      nodePort: ${NODE_PORT}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fleet-satellite
  namespace: ${SAT_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: fleet-satellite-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: fleet-satellite
    namespace: ${SAT_NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fleet-satellite
  namespace: ${SAT_NAMESPACE}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: {app: fleet-satellite}
  template:
    metadata:
      labels: {app: fleet-satellite}
    spec:
      # hostNetwork puts the management node's loopback in reach, which is how
      # the satellite uses the NodePort over plain HTTP. The link accepts a
      # cleartext endpoint for loopback only.
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      serviceAccountName: fleet-satellite
      containers:
        - name: satellite
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          command: [/manager]
          args:
            - satellite
            - --satellite-control-plane-url=http://127.0.0.1:${NODE_PORT}
            - --satellite-cluster-name=mgmt-satellite
            - --satellite-cluster-namespace=${NAMESPACE}
            - --satellite-display-name=Management (satellite)
            - --satellite-token-file=/var/run/paprika-satellite/token
            - --satellite-heartbeat-interval=10s
            - --satellite-batch-interval=2s
            - --satellite-autonomy=Failover
            - --satellite-stream-enabled=true
            - --health-probe-bind-address=:8081
            - --metrics-bind-address=0
          volumeMounts:
            - name: token
              mountPath: /var/run/paprika-satellite
              readOnly: true
      volumes:
        - name: token
          secret:
            secretName: mgmt-satellite-token
---
apiVersion: clusters.paprika.io/v1alpha1
kind: Cluster
metadata:
  name: mgmt-satellite
  namespace: ${NAMESPACE}
spec:
  displayName: Management via satellite
  mode: agent
  labels:
    region: local
    transport: satellite
  satellite:
    tokenSecretRef:
      name: mgmt-satellite-satellite-token
      key: token
EOF

  info "waiting for registrations to report Healthy"
  for _ in $(seq 1 60); do
    healthy=$(kubectl --context "$MGMT_CTX" -n "$NAMESPACE" get clusters \
      -o jsonpath='{range .items[*]}{.status.phase}{"\n"}{end}' | grep -c Healthy || true)
    if [ "$healthy" -ge 4 ]; then
      info "four registrations Healthy"
      status
      return
    fi
    sleep 2
  done
  echo "registrations did not all become Healthy; run '${0} status'" >&2
  status || true
  exit 1
}

status() {
  require
  info "clusters"
  kubectl --context "$MGMT_CTX" -n "$NAMESPACE" get clusters \
    -o custom-columns=NAME:.metadata.name,MODE:.spec.mode,PHASE:.status.phase,STATE:.status.satellite.operatingState --no-headers || true
  info "satellite"
  kubectl --context "$MGMT_CTX" -n "$NAMESPACE" get cluster mgmt-satellite \
    -o jsonpath='link={.status.satellite.operatingState} lastSeen={.status.satellite.lastSeen} session={.status.satellite.sessionId}{"\n"}' || true
  info "applications"
  kubectl --context "$MGMT_CTX" -n "$APP_NAMESPACE" get applications.pipelines.paprika.io \
    -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,STAGE:.status.currentStage --no-headers || true
  info "rollouts"
  kubectl --context "$MGMT_CTX" -n "$APP_NAMESPACE" get rollouts.rollouts.paprika.io \
    -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,CLUSTER:.spec.cluster.name --no-headers || true
  info "bundle store"
  kubectl --context "$MGMT_CTX" -n "$SAT_NAMESPACE" get cm paprika-satellite-bundles \
    -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || echo "(no bundles recorded)"
}

seed() {
  require
  info "dispatching a sample bundle through the internal listener"
  local manifests payload
  manifests=$(printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fleet-seed\n  namespace: %s\ndata:\n  v: "1"\n' "$APP_NAMESPACE" | base64 | tr -d '\n')
  payload=$(printf '{"namespace":"%s","name":"mgmt-satellite","task":{"apply":{"namespace":"%s","appName":"fleet-seed","manifests":"%s"}}}' \
    "$NAMESPACE" "$APP_NAMESPACE" "$manifests")
  kubectl --context "$MGMT_CTX" -n "$NAMESPACE" port-forward "deploy/${RELEASE}-controller-manager" 18082:8082 >/dev/null 2>&1 &
  local forward_pid=$!
  trap 'kill "$forward_pid" 2>/dev/null || true' RETURN
  sleep 3
  curl -sf -X POST http://127.0.0.1:18082/internal/satellite/dispatch \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${INTERNAL_TOKEN}" \
    --data-binary "$payload"
  printf '\n'
  kubectl --context "$MGMT_CTX" -n "$APP_NAMESPACE" get cm fleet-seed \
    -o jsonpath='applied fleet-seed v={.data.v}{"\n"}'
}

down() {
  require
  local clusters=()
  for name in "$MGMT_CLUSTER" "$EU_CLUSTER" "$US_CLUSTER"; do
    if cluster_exists "$name"; then
      clusters+=("$name")
    fi
  done
  if [ ${#clusters[@]} -eq 0 ]; then
    info "no fleet clusters to delete"
    return
  fi
  info "deleting ${clusters[*]}"
  kind delete clusters "${clusters[@]}"
  rm -f /tmp/fleet-*.kubeconfig
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  seed) seed ;;
  down) down ;;
  *)
    printf 'usage: %s {up|status|seed|down}\n' "$0" >&2
    exit 2
    ;;
esac
