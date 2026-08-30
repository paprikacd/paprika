# Operations Guide

How to build, deploy, debug, and verify Paprika on a Kubernetes cluster.

## Cluster Access

### Prerequisites

- `kubectl` configured with the target cluster's kubeconfig
- Docker (for building images)
- `helm` v3 (for production deploys)
- `go` 1.26+ (for building from source)

### Confirm the Context

Always confirm the current kubectl context before any mutation:

```sh
kubectl config current-context
```

The VKE cluster context is `admin@vke-<cluster-id>`. Do not use local Kind
contexts (e.g. `kind-deephost`) for paprika work.

### Namespaces

| Namespace | Contents |
|-----------|----------|
| `paprika-e2e` | Paprika control plane (controller-manager, api-server, repo-server, webhook-receiver) |
| `deephost` | DeepHost platform (managed via `Application/deephost`) |
| `envoy-gateway-system` | Shared Envoy Gateway and TLS listener |
| `knative-serving` | Knative Serving (for Knative-mode applications) |

## Building Images

### Fast Iteration (Go-only, ~1 second)

Use `Dockerfile.fast` for controller-manager iteration. It skips the UI build
and uses build cache mounts:

```sh
make docker-build-fast IMG=ghcr.io/paprikacd/paprika:<tag>
```

Or directly:

```sh
docker buildx build --platform linux/amd64 \
  -f Dockerfile.fast \
  -t ghcr.io/paprikacd/paprika:<tag> \
  --push .
```

This is the recommended approach for controller changes. The
controller-manager does not serve the UI; the api-server deployment uses the
full image.

### Full Build (UI + Go, ~20 minutes)

Use the full `Dockerfile` when the UI or api-server changes:

```sh
make docker-build IMG=ghcr.io/paprikacd/paprika:<tag>
make docker-push IMG=ghcr.io/paprikacd/paprika:<tag>
```

### ttl.sh Fallback

When ghcr.io is unavailable, use ttl.sh (anonymous, ephemeral):

```sh
docker build --platform linux/amd64 -t ttl.sh/paprika-amd64:<tag> .
docker push ttl.sh/paprika-amd64:<tag>
```

Tags are TTL durations (e.g. `4h`, `24h`). The image auto-deletes after expiry.

### Platform

Always build for `linux/amd64`. The build host is Apple Silicon (arm64) but
VKE nodes are amd64. `docker buildx --platform linux/amd64` handles
cross-compilation via QEMU.

## Deploying

### Iteration (kubectl set image)

For quick controller-manager iteration, update only the controller-manager
Deployment:

```sh
# Get the pushed digest
docker buildx imagetools inspect ghcr.io/paprikacd/paprika:<tag>

# Update the deployment
kubectl -n paprika-e2e set image deployment/paprika-e2e-controller-manager \
  manager=ghcr.io/paprikacd/paprika@sha256:<digest>

# Wait for rollout
kubectl -n paprika-e2e rollout status \
  deployment/paprika-e2e-controller-manager --timeout=240s
```

This approach is fast but bypasses Helm. The deployment's image field will
diverge from the Helm release values.

### Production (Helm)

For production deploys, use Helm so `helm rollback` works:

```sh
source .env && helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID" \
  --set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET" \
  --set "manager.image.repository=ghcr.io/paprikacd/paprika" \
  --set "manager.image.tag=<tag>" \
  --wait --timeout 5m
```

For digest-pinned deploys (immutable, no tag mutation risk):

```sh
helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "manager.image.repository=ghcr.io/paprikacd/paprika@sha256:<digest>" \
  --wait --timeout 5m
```

### CRD Updates

After API type changes, regenerate and apply CRDs:

```sh
# Regenerate
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases

# Copy to chart
for f in config/crd/bases/pipelines.paprika.io_{applications,applicationsets,releases}.yaml; do
  base=$(basename $f)
  chart_name=$(echo $base | sed 's/pipelines.paprika.io_//;s/\.yaml$/.pipelines.paprika.io.yaml/')
  cp "$f" "charts/chart/templates/crd/$chart_name"
done

# Apply to cluster (or let Helm manage them)
kubectl apply -f config/crd/bases/pipelines.paprika.io_applications.yaml
kubectl apply -f config/crd/bases/pipelines.paprika.io_releases.yaml
```

## Verifying

### Application Health

```sh
# All apps
kubectl get applications -n paprika-e2e

# Specific app
kubectl get application <app> -n <ns> -o json | jq '{
  phase: .status.phase,
  health: .status.health,
  oos: .status.outOfSync,
  notSynced: [.status.resources[] | select(.status!="Synced")]
}'
```

Expected: `phase: Healthy`, `health: Healthy`, `outOfSync: null` (or 0),
`notSynced: []`.

### Prunable Resources Preview

```sh
kubectl get application <app> -n <ns> -o json | jq '.status.prunableResources'
```

Shows what would be pruned on the next apply with `syncOptions.prune` enabled.

### Stale Conditions

```sh
kubectl get application <app> -n <ns> -o json | jq \
  '[.status.conditions[] | select(.status=="True" and (.type=="Degraded" or .type=="RolledBack" or .type=="Pending" or .type=="ReleaseRetriesExhausted"))]'
```

Should be empty after recovery.

### Public Endpoints

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.deephost.benebsworth.com/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.deephost.benebsworth.com/
```

## Debugging

### Controller Logs

```sh
# Recent logs
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m

# Follow logs
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager -f

# Filter for specific app
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m | grep -i <app-name>

# Filter for errors
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m | grep -iE 'error|panic|failed'
```

### Metrics

The metrics endpoint is HTTP on port 8443 (not HTTPS — the controller uses
`--metrics-secure=false`):

```sh
kubectl -n paprika-e2e port-forward \
  svc/paprika-e2e-controller-manager-metrics-service 8443:8443 &

curl -s http://localhost:8443/metrics | grep paprika_
```

Key metrics for debugging:

- `paprika_out_of_sync{app, namespace}` — current drift count
- `paprika_prunable{app, namespace}` — current prunable count
- `paprika_prune_total{app, namespace, kind}` — prune activity
- `paprika_application_phase_total{application, namespace, phase}` — phase
  transitions

### Manual Sync

Force a release retry (e.g. after fixing a terminal release):

```sh
kubectl -n <ns> annotate application <app> \
  paprika.io/sync="$(date +%s)" paprika.io/manual-sync="$(date +%s)" --overwrite
```

### Release Investigation

```sh
# List releases for an app
kubectl get releases.pipelines.paprika.io -n <ns> --sort-by=.metadata.creationTimestamp | grep <app>

# Release conditions
kubectl get releases.pipelines.paprika.io <release-name> -n <ns> -o json | \
  jq '.status.conditions[] | {type, status, reason, message}'

# Release manifest snapshot
kubectl get configmap <snapshot-name> -n <ns> -o json | jq -r '.data["manifests.yaml"]'
```

### RBAC Issues

If apply fails with "attempting to grant RBAC permissions not currently held":

```sh
# Check what the manager can do
kubectl auth can-i <verb> <resource> --as=system:serviceaccount:paprika-e2e:paprika-e2e-controller-manager -n <ns>

# Check the manager's ClusterRole
kubectl get clusterrole paprika-e2e-manager-role -o yaml
```

Extend the chart-managed manager role (`charts/chart/templates/rbac/manager-role.yaml`)
with the exact target permissions. Never add an unrelated cluster-admin binding.

### Drift Investigation

```sh
# What's out of sync
kubectl get application <app> -n <ns> -o json | \
  jq '[.status.resources[] | select(.status!="Synced")]'

# Compare desired vs live for a specific resource
kubectl get <kind> <name> -n <ns> -o json | jq '.spec'

# Check the release's manifest snapshot
kubectl get releases.pipelines.paprika.io <release> -n <ns> -o json | \
  jq '.status.renderedManifestSnapshot'
```

## Rolling Back

### Controller Rollback (Helm)

```sh
helm rollback paprika-e2e -n paprika-e2e
```

### Application Rollback

If a release fails, the application rolls back automatically (if
`onFailure.action: rollback`). For manual rollback:

```sh
# Check previous releases
kubectl get releases.pipelines.paprika.io -n <ns> --sort-by=.metadata.creationTimestamp | grep <app>

# The rollback happens automatically on failure. To force a clean state,
# trigger a manual sync after fixing the source:
kubectl -n <ns> annotate application <app> \
  paprika.io/sync="$(date +%s)" paprika.io/manual-sync="$(date +%s)" --overwrite
```

## Common Issues

### "connection refused" on webhook

The Knative serving webhook is down. Check:

```sh
kubectl get pods -n knative-serving
kubectl get endpoints webhook -n knative-serving
```

### "attempting to grant RBAC permissions not currently held"

The paprika manager's ClusterRole doesn't have the permissions the chart's
ClusterRole grants. Extend `charts/chart/templates/rbac/manager-role.yaml`.

### "unknown field" on kubectl apply

The cluster CRD predates the new field. Apply the updated CRD first:

```sh
kubectl apply -f config/crd/bases/pipelines.paprika.io_applications.yaml
```

### Pruned resources not being deleted

Prune is opt-in. Check that the Application has `syncOptions.prune: true`:

```sh
kubectl get application <app> -n <ns> -o json | jq '.spec.syncOptions'
```

### Metrics endpoint not responding

The metrics endpoint is HTTP on port 8443, not HTTPS. Use
`http://localhost:8443/metrics` after port-forwarding.
