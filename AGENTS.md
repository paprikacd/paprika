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
- api-server e2e resources are pinned to 100m/192Mi via
  `deploy/test-values.yaml` (chart defaults are 1000m/256Mi) — the 0.1-core
  cap makes bcrypt basic auth ~1s/request and amplifies GC pressure, so
  latency measurements there are worst-case, not representative of defaults.
- The :3000 listener bounds concurrent connections via `--api-max-conns`
  (default 128, kernel accept-queue backpressure) — an unbounded flood of
  ~300 conns OOM-killed the 96Mi pod before this existed. `IdleTimeout`
  (90s) is set so idle keep-alives can't exhaust the cap.
- `/mcp` and embedded UI responses are gzip-compressed when the client
  sends Accept-Encoding: gzip — a 20KB fleet_map result is ~2KB on the
  wire (the structuredContent/text duplication compresses away).
- Per-tool MCP metrics exist: `paprika.mcp.tool.calls`,
  `paprika.mcp.tool.duration`, `paprika.mcp.tool.response_bytes` with
  tool+outcome attributes.
- MCP read tools over port-forward: ~180ms/call sequential, ~14.8 calls/s
  aggregate under 3 concurrent workers (post authz-informer optimization).
- Profiling baseline (MCP read load): ~50% of cumulative allocs is upstream
  MCP SDK JSON decode; paprika-controlled hotspots after the AppProject
  informer fix are `fleet.Snapshot` queries, `mcp.toolResult` (payload is
  emitted twice: structured + text), and `auth.verifySelfSigned`.

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
# pprof: enable with --pprof-bind-address=:6060 (flag exists on every mode,
# patched into paprika-e2e api-server + controller-manager args). Reach it
# only through port-forward — no Service/Ingress exposes 6060.
kubectl -n paprika-e2e port-forward deployment/paprika-e2e-api-server 16060:6060 &
hack/pprof-capture.sh http://localhost:16060 30 /tmp/paprika-perf/api

# Load gen (needs an MCP bearer token in MCP_TOKEN or MCP_TOKEN_FILE):
kubectl -n paprika-e2e port-forward deployment/paprika-e2e-api-server 13000:3000 &
MCP_TOKEN=... BASE=http://localhost:13000 hack/mcp-loadgen.sh 60

# Caveat: kubectl port-forward adds hundreds of ms per connection and can
# degrade to >1s/conn when the VKE control plane is slow — it dominates
# per-call latency numbers, masking real server-side cost (~50-100ms/call
# measured pod-locally via `kubectl exec ... wget localhost:3000/mcp`).
# For latency comparisons, drive load inside the pod or reuse one HTTP
# connection; use port-forward only for pprof/profile capture.

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
- **ServiceMonitor RBAC in manager role**: managed apps can render
  `ServiceMonitor`s (flaggr-api does); the manager ClusterRole lacked
  `monitoring.coreos.com` verbs, which made every release apply fail with
  RBAC errors and wedge apps at `ReleaseRetriesExhausted`. Granted the full
  verb set in `charts/chart/templates/rbac/manager-role.yaml` (replaces a
  hand-created `paprika-e2e-servicemonitor-manager` ClusterRole/Binding that
  has been deleted — do not recreate).
- **Revision-only source drift no longer churns releases**: git source hashes
  are `<commit>:<dirHash>`; `checkSourceChanged` now compares only the content
  segment and pins `SourceHash`/`SourceRevision` to the commit that introduced
  the current content. Previously every unrelated repo commit superseded the
  active release and restarted canaries from step 0 (flaggr-api docs push →
  full ~100min restart). OCI/S3 were already content-only.
- **Flaggr evaluator cutover dogfooded**: flaggr-api rollout is driven by
  native Release canary — Application declares `canary.steps [0,1,10,50,100]`
  + `intervalSeconds 600`, the flaggr chart renders `canaryWeight` into
  HTTPRoute backend weights (no `trafficRouter` on the stage), and
  `analysis.checks` probe candidate/fallback/public `/healthz` plus a
  `podMetrics` restartRate check on the canary pods per step.
- **Rollback hardening (battle-tested live on flaggr-api)**:
  - Superseded releases are valid rollback targets — their
    `status.RenderedManifestSnapshot` is the steady-state render. Excluding
    them meant a rollback of a just-replaced release had no target at all.
  - `markRolledBack` spends the release's auto-retry budget so the app's
    adopt+auto-resync path cannot resurrect a rolled-back release and
    re-run the canary that was meant to stop. Manual sync still bypasses.
  - A parked (retry-exhausted) app still watches release identity, not just
    the source hash — a param change produces a different release name and
    must start a new flow instead of wedging in RolledBack.
  - `patchApplicationReleaseRef` retries on optimistic-concurrency
    conflicts; the release and app controllers race on status writes.
  - Verified live: `paprika.io/rollback-requested` on a canarying release →
    superseded snapshot restored (route 100/0), release `RolledBack`,
    app parked `ReleaseRetriesExhausted`, no resurrection; param revert →
    adopted+resynced the prior release (self-heal re-canary).
- **Analysis hardening**: results persist as a `CanaryAnalysis` status
  condition + Kubernetes event (were metrics-only). `analysis.Result`
  carries the check type so metric labels don't depend on goroutine order.
  `podMetrics` checks take `podSelector` and list pods in the analyzed
  resource's namespace — no selector, zero matching pods, and the
  unimplemented `latencyP99` metric all fail closed now (were silent passes
  via a hardcoded `demo-app` selector in the operator namespace).
- **Standalone Releases stay valid**: `checkApprovalGates` degrades to
  stage-only gates when a Release has no Application owner
  (`errNoApplicationOwner`), same as `runGovernanceGate`. The nightly e2e
  (direct `kubectl apply` of a Release) caught the original hard-fail.
- **Basic auth verification cache**: bcrypt results cached 60s keyed by
  SHA-256 of the credential, singleflight-shared, capped at 1024 entries —
  per-request bcrypt was ~1s at the e2e 100m CPU pin (DoS amplifier).
- **h2c on paprika listeners** (`internal/httpx.WithH2C`): API/UI,
  repo-server and agent accept prior-knowledge h2 alongside HTTP/1.1 on one
  port via `http.Server.Protocols` (native since Go 1.24; `x/net/http2/h2c`
  is deprecated). Bounded at 256 concurrent streams. Deploy order matters:
  servers accept both protocols, so roll server images before clients that
  speak h2c unconditionally (`httpx.ConnectTransport` does for `http://`).
- **Tuned k8s client rate limits**: API-mode config and every config minted
  via `clusterconfig` (`ForCluster`, `Resolver`, dataprovider fallback,
  webhook/agent/repo-server modes) run QPS=50/Burst=100 — client-go's 5/10
  default throttled uncached calls.
- **Bounded informer set**: the API cache client sets `DisableFor` for
  Secret and ConfigMap — reads of non-warmed types through the cached
  client lazily start cluster-wide informers (a Secret informer caches
  every Secret in the cluster for what is a keyed GET). Keep the warmed
  set + DisableFor list in sync with what request paths actually read.

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
