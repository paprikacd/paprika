# Agent Instructions

## Goal

Operate and improve Paprika on the VKE cluster. Fix bugs, add features,
deploy changes safely, and keep the shared `paprika-e2e` namespace healthy.

## Constraints & Preferences

- OTel SDK with Prometheus exporter for metrics (not direct Prometheus client
  for new metrics). Existing metrics in `internal/metrics/metrics.go` use the
  Prometheus client directly; both are registered on controller-runtime's
  `metrics.Registry` and appear at `/metrics`.
- GitHub Actions builds and pushes to `ghcr.io/paprikacd/paprika` (GHA
  `GITHUB_TOKEN` has `packages: write`). Local iteration pushes go to
  `ttl.sh/paprika-amd64:<tag>` (anonymous, TTL) as fallback.
- Images must be built for `linux/amd64` — VKE nodes are amd64 (x86_64), build
  host is Apple Silicon (arm64, QEMU emulated).
- Vultr has no ARM plans globally; ARM VKE not feasible.

## Safe Kubernetes Operations

- Confirm `kubectl config current-context` before every cluster mutation.
- Use the configured VKE context only for the VKE environment. Do not use
  `kind-deephost` for paprika work.
- Prefer `Taskfile.yml` tasks and `Makefile` targets over ad hoc commands so
  workflows are repeatable.
- Render Helm changes before applying them (`helm template`).
- After a write, inspect the resulting object and status; API writes can race
  or be retried by controllers.
- Never commit kubeconfigs, Cloudflare credentials, registry credentials,
  bearer tokens, or temporary rendered manifests containing secrets.
- Never use destructive Git commands to discard work from another contributor.
- Never solve a target ClusterRole escalation error by adding an unrelated
  cluster-admin binding. Extend the chart-managed manager role with the exact
  target permissions, render/lint the chart, upgrade Paprika, check
  `kubectl auth can-i`, and retry.

## Required Verification

For Go changes, run:

```sh
go build ./...
go test ./internal/engine ./internal/controller/pipelines -count=1
go vet ./internal/... ./cmd/...
```

For chart, CRD, or controller changes, also run:

```sh
helm lint charts/chart/
helm template paprika charts/chart/
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases
# Then copy CRDs to the chart:
#   for f in config/crd/bases/pipelines.paprika.io_{applications,applicationsets,releases}.yaml; do
#     base=$(basename $f); chart_name=$(echo $base | sed 's/pipelines.paprika.io_//;s/\.yaml$/.pipelines.paprika.io.yaml/')
#     cp "$f" "charts/chart/templates/crd/$chart_name"
#   done
```

For deployed image changes, build an immutable tag, push it to the registry,
update only the intended Deployment, wait for rollout, and verify the live
endpoint:

```sh
# Fast iteration (Go-only, ~1s with cache):
make docker-build-fast IMG=ghcr.io/paprikacd/paprika:<tag>

# Full build (UI + Go, ~20 min):
make docker-build IMG=ghcr.io/paprikacd/paprika:<tag>
make docker-push IMG=ghcr.io/paprikacd/paprika:<tag>

# Deploy to controller-manager only:
kubectl -n paprika-e2e set image deployment/paprika-e2e-controller-manager \
  manager=ghcr.io/paprikacd/paprika@sha256:<digest>
kubectl -n paprika-e2e rollout status deployment/paprika-e2e-controller-manager --timeout=240s

# Verify:
kubectl get applications -n paprika-e2e
kubectl get application <app> -n <ns> -o json | jq '.status.outOfSync'
```

For production deploys (not iteration), use Helm so `helm rollback` works:

```sh
helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set manager.image.repository=ghcr.io/paprikacd/paprika \
  --set manager.image.tag=<tag> \
  --wait --timeout 5m
```

## Architecture Invariants

- `Application`, `Release`, `Stage`, and `Template` CRs are the system of
  record. The Application controller watches the source, creates Releases,
  and evaluates health/drift. The Release controller applies manifests and
  manages promotion.
- The diff engine (`ScalableDiffEngine`) compares desired manifests against
  live resources using label selectors (`app.paprika.io/managed-by=paprika`,
  `app.paprika.io/name=<app>`). It uses apiVersion-qualified resource keys to
  distinguish same-kind resources across API groups (e.g. Knative Service vs
  core Service).
- GVR resolution uses a three-tier strategy: static `knownGVRs` fast path,
  discovery API with caching, pluralization fallback. The resolver is
  `CachedGVRResolver` in `internal/engine/gvr_resolver.go`.
- Prune is opt-in via `SyncOptions.Prune` (default false). When enabled,
  `pruneStaleResources` deletes live resources that are paprika-labelled,
  ownerless, and not in the desired manifest set. Resources annotated
  `paprika.io/prune: "false"` are never pruned. Only namespaced resources are
  pruned by default; ClusterRole and ClusterRoleBinding are eligible via
  `SyncOptions.PruneClusterScopedKinds`.
- The release controller sets `app.paprika.io/release` on every applied
  resource so `cleanupManagedResources` can find them on release deletion.
- Failure conditions (`Degraded`, `RolledBack`, `Pending`,
  `ReleaseRetriesExhausted`) are cleared when the Application transitions to
  Healthy.

## Current State

- All 14 apps in `paprika-e2e` are Healthy with outOfSync=0.
- DeepHost is Healthy with outOfSync=0, all resources Synced.
- The controller-manager runs an immutable GHCR digest.
- Metrics live at `:8443/metrics` (HTTP, `--metrics-secure=false`).

## Key Metrics

- `paprika_out_of_sync{app, namespace}` — current out-of-sync resource count
  (gauge). Alert on > 0 for > 5 minutes.
- `paprika_prunable{app, namespace}` — current prunable resource count
  (gauge). Alert on > 0 for > 10 minutes.
- `paprika_prune_total{app, namespace, kind}` — resources pruned per apply
  (counter). Alert on unexpected spikes.
- `paprika_application_phase_total{application, namespace, phase}` — phase
  transitions (counter).
- `paprika_reconcile_total{controller, result}` — reconciliation count.

## Commands

### Build & Test

```sh
go build ./...
go test ./internal/engine ./internal/controller/pipelines -count=1
go test ./... -count=1
go vet ./internal/... ./cmd/...
helm lint charts/chart/
```

### Build Image

```sh
# Fast iteration (Go-only, ~1s with cache):
make docker-build-fast IMG=ghcr.io/paprikacd/paprika:<tag>

# Full build (UI + Go):
make docker-build IMG=ghcr.io/paprikacd/paprika:<tag>
make docker-push IMG=ghcr.io/paprikacd/paprika:<tag>

# ttl.sh fallback:
docker build --platform linux/amd64 -t ttl.sh/paprika-amd64:<tag> . && \
  docker push ttl.sh/paprika-amd64:<tag>
```

### Deploy

```sh
# Iteration (controller-manager only):
kubectl -n paprika-e2e set image deployment/paprika-e2e-controller-manager \
  manager=ghcr.io/paprikacd/paprika@sha256:<digest>
kubectl -n paprika-e2e rollout status deployment/paprika-e2e-controller-manager --timeout=240s

# Production (all components, Helm-managed):
source .env && helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID" \
  --set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET" \
  --wait --timeout 5m
```

### Debug

```sh
# Controller logs:
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m

# Application status:
kubectl get application <app> -n <ns> -o json | jq '{
  phase: .status.phase,
  health: .status.health,
  oos: .status.outOfSync,
  notSynced: [.status.resources[] | select(.status!="Synced")]
}'

# Prunable resources preview:
kubectl get application <app> -n <ns> -o json | jq '.status.prunableResources'

# Metrics (HTTP, not HTTPS):
kubectl -n paprika-e2e port-forward svc/paprika-e2e-controller-manager-metrics-service 8443:8443 &
curl -s http://localhost:8443/metrics | grep paprika_

# Manual sync (force release retry):
kubectl -n <ns> annotate application <app> \
  paprika.io/sync="$(date +%s)" paprika.io/manual-sync="$(date +%s)" --overwrite
```

### CRD Management

```sh
# Regenerate CRDs after API type changes:
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases

# Copy to chart templates:
for f in config/crd/bases/pipelines.paprika.io_{applications,applicationsets,releases}.yaml; do
  base=$(basename $f)
  chart_name=$(echo $base | sed 's/pipelines.paprika.io_//;s/\.yaml$/.pipelines.paprika.io.yaml/')
  cp "$f" "charts/chart/templates/crd/$chart_name"
done

# Apply to cluster:
kubectl apply -f config/crd/bases/pipelines.paprika.io_applications.yaml
kubectl apply -f config/crd/bases/pipelines.paprika.io_releases.yaml
```

## Relevant Files

- `internal/engine/scalable_diff.go`: ScalableDiffEngine — label-selector
  diff computation, apiVersion-qualified resource keys, generated-child
  exclusion.
- `internal/engine/diff.go`: DiffEngine (basic), resourceEqual, specContains,
  mapContains — null-as-absent handling, Kubernetes default omission.
- `internal/engine/gvr_resolver.go`: CachedGVRResolver — discovery API with
  caching, knownGVRs fast path, pluralization fallback.
- `internal/controller/pipelines/release_controller.go`: applyManifests,
  applyAllDocuments, applyDocument, pruneStaleResources, setPaprikaLabels,
  cleanupManagedResources, gvrFromKind.
- `internal/controller/pipelines/application_controller.go`: evaluateDiff,
  setApplicationPhase, handleActiveRelease, buildRelease.
- `internal/metrics/metrics.go`: All Prometheus collectors (direct client).
- `internal/metrics/otel.go`: All OTel instruments (counters, histograms,
  observable gauges).
- `api/pipelines/v1alpha1/application_types.go`: SyncOptions (Prune,
  PruneClusterScopedKinds, PrunePropagationPolicy, Replace, Force,
  ApplyOutOfSyncOnly, HookTimeoutSeconds).
- `Dockerfile.fast`: Go-only build with cache mounts (~1s with cache).
- `Dockerfile`: Full build (UI + Go, ~20 min).
- `docs/guides/deephost.md`: DeepHost integration and E2E flow.
- `docs/guides/operations.md`: Build, deploy, and debug operations.
- `docs/guides/drift-and-prune.md`: Drift detection and pruning guide.
- `docs/guides/metrics.md`: Metrics and alerting guide.

## Progress

### Done

- **Null-drift false positives**: declared JSON `null` values (e.g. `env
  value: null`) were flagged as drift forever because server-side apply drops
  the key. Fixed: null = "field absent" in mapContains.
- **API group key collision**: `resourceKey` used bare Kind/ns/name, collapsing
  Knative Service and core Service onto each other. Fixed: apiVersion-qualified
  keys. Also fixed `gvrForObject` to respect the manifest's API group.
- **Generated-child prune exclusion**: Knative Route's ExternalName Service
  (with copied paprika labels) was classified as Pruned. Fixed: skip live
  resources owned by kinds absent from the desired set.
- **Prune-after-apply**: `pruneStaleResources` runs after successful apply,
  deleting ownerless paprika-labelled resources not in the desired set. Opt-in
  via `SyncOptions.Prune`. Prune protection via `paprika.io/prune: "false"`
  annotation.
- **Cluster-scoped prune**: ClusterRole and ClusterRoleBinding eligible by
  default; Namespaces and CRDs never pruned. Override via
  `SyncOptions.PruneClusterScopedKinds`.
- **Stale-condition cleanup**: failure conditions cleared on Healthy transition.
- **Discovery-based GVR resolution**: `CachedGVRResolver` replaces hand-maintained
  knownGVRs with discovery API + caching + pluralization fallback.
- **Release label on applied resources**: `app.paprika.io/release` set on every
  applied resource for cleanupManagedResources.
- **Drift alerting gauges**: `paprika_out_of_sync` and `paprika_prunable`
  gauges updated on every diff evaluation.
- **Prune preview**: `status.prunableResources` lists what would be pruned.
- **Prune metric**: `paprika_prune_total{app, namespace, kind}` counter.
- **Dockerfile.fast**: Go-only build with cache mounts (~1s with cache vs 20+
  min for full Dockerfile).
- **WIP committed**: cluster-scoped resources, TargetNamespace, ValuesFile,
  status sorting, RBAC, and documentation were committed as a coherent feature
  set.

### In Progress

- (none)

### Blocked

- (none)

## Next Steps

1. Set up Prometheus alerting rules for `paprika_out_of_sync > 0` and
   `paprika_prunable > 0` to surface drift accumulation automatically.
2. Consider Grafana dashboards for the new drift and prune metrics.
3. Replace the broad Cloudflare credential with a scoped token for the
   `benebsworth.com` zone.
4. Keep the Paprika-to-DeepHost runbook in `docs/guides/deephost.md` aligned
   with the deployed CRD and chart behavior.
5. When agent-mode is adopted for remote clusters, add prune support to the
   agent server (currently local-apply only).
