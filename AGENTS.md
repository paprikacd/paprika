## Goal
- Operate and instrument Paprika on the omega VKE cluster, fixing auth/RBAC/renderer bugs, deploying a git-synced demo app, optimising resources, and adding OTel Prometheus metrics.

## Constraints & Preferences
- OTel SDK with Prometheus exporter for metrics (not direct Prometheus client for new metrics).
- OTel Prometheus exporter registered on controller-runtime's `metrics.Registry` so OTel metrics appear alongside standard metrics at `/metrics` endpoint without a separate port or handler.
- New metrics use OTel API (`otel.Meter("paprika").Int64Counter(...)`) while existing metrics (`internal/metrics/metrics.go`) remain as direct Prometheus.
- GitHub Actions builds and pushes to `ghcr.io/paprikacd/paprika` (GHA `GITHUB_TOKEN` has `packages: write` scope). Local pushes go to `ttl.sh` (anonymous ephemeral) as fallback.
- Images must be built for `linux/amd64` — VKE nodes are amd64 (x86_64), build host is Apple Silicon (arm64, QEMU emulated).
- Vultr has no ARM plans globally; ARM VKE not feasible.

## Progress
### Done
- **Fixed infinite redirect loop**: root cause was `cleanUIPath` returning trailing-slash paths → `embed.FS.Open()` failed → SPA fallback served root `index.html` for ALL routes → infinite self-redirect. Fix: strip trailing slashes in `cleanUIPath` (`internal/api/uihandler.go`).
- **Fixed RBAC rules**: `subjects: ["*"]` (any authenticated user) instead of `group:users`.
- **Fixed HelmSDKRenderer**: added `git`, `oci`, `s3` source types to `Render()`/`RenderAll()` switch; removed duplicate path join in `resolveChartPath`.
- **Deployed git-synced demo app** (`paprika-demo.benebsworth.com`) via Application CR with nginx-unprivileged, port 8080, non-root.
- **Resource trimming**: reduced limits 13× CPU / 10× memory based on actual usage. Reduced replicas from 2→1 per component. Disabled PDBs.
- **OTel Prometheus exporter** wired up in `internal/observability/observability.go` — always creates Prometheus reader + MeterProvider (even without OTLP endpoint), registered on `crmetrics.Registry`.
- **OTel instruments** (`internal/metrics/otel.go`): render (total/errors/duration), sync (total/errors/duration/last_timestamp), auth (attempts/failures/denials/decisions), git (operations/errors/duration), source resolve (total/errors), SSE (connections/events_published), release transitions, active applications, releases by phase.
- **Instrumented code paths**: renderer (`helm_sdk_renderer.go`), auth middleware (`middleware.go`), release controller (`release_controller.go`), git source resolver (`git.go`), SSE broker (`broker.go`).
- **Kubernetes gauge callbacks** (`internal/metrics/kubernetes.go`): `RegisterKubernetesGaugeCallbacks` lists Applications/Releases from K8s API on each scrape, populates `applications_active`, `applications_by_phase`, `releases_active`, `releases_by_phase` with `phase` attribute.
- **OTel added to all modes**: `runAPIMode`, `runWebhookMode`, `runRepoServerMode`, `runAgentMode` all call `observability.NewTelemetry()` + `defer telemetry.Shutdown()`.
- **Rebuilt and deployed** (amd64, ttl.sh `4h` tag), verified OTel metrics on controller-manager (git, SSE, events, gauges all visible).

### In Progress
- (none)

### Blocked
- (none)

## Next Steps
1. Commit and push to `master` → GHA builds `ghcr.io/paprikacd/paprika:latest`
2. Switch `test-values.yaml` from `ttl.sh/paprika-amd64:4h` to `ghcr.io/paprikacd/paprika:latest`
3. Redeploy with `helm upgrade`
4. Create a scoped Cloudflare API token for `benebsworth.com` zone (currently using Global API key)

## Verified Metrics on Controller-Manager
- `paprika_git_duration_seconds_bucket` (1 fetch at 22.5s)
- `paprika_git_operations_total` (1 op)
- `paprika_sse_connections` (1 active)
- `paprika_events_published_total{topic="dashboard"}` (1 event)
- `paprika_applications_active_ratio` (1 app: demo-app)
- `paprika_applications_by_phase_ratio{phase="Healthy"}` (1)
- `paprika_releases_active_ratio` (0 — release is terminal)
- `paprika_releases_by_phase_ratio{phase="Complete"}` (1)

Note: OTel Prometheus exporter adds `_ratio` suffix to observable gauge names when unit is "1" (dimensionless). Synchronous instruments (counters, histograms, updowncounters) use the name as-is.

## Key Decisions
- **All modes get OTel**: `NewTelemetry` called in all 5 `run*Mode` functions (operator, API, webhook, repo-server, agent). Each creates its own MeterProvider scoped to that process's lifecycle.
- **Observable gauges register callbacks only in operator mode** (where cache-backed `mgr.GetClient()` is available). API/webhook/repo-server/agent modes don't register K8s callbacks — gauges silently absent from their `/metrics` output.
- **`_ratio` suffix on observable gauge names** is expected OTel Prometheus exporter behavior for dimensionless (unit "1") instruments. Not a bug.
- **GitHub Actions CI/CD**: existing `.github/workflows/build-push.yml` builds and pushes `ghcr.io/paprikacd/paprika:{latest,sha-<sha>}` on push to `master`. The `GITHUB_TOKEN` has `packages: write` scope (unlike local machine's token).
- **`ttl.sh` fallback**: when local builds can't push to ghcr.io, use `ttl.sh/paprika-amd64:<tag>` with `<tag>` being the TTL duration (e.g., `4h`). Image auto-deletes after TTL. Must rebuild before expiry.
- **`--platform linux/amd64` for Docker builds**: build host is Apple Silicon (arm64) → images are arm64-only. VKE nodes are amd64. Must explicitly target `linux/amd64`.
- **`metric.WithExplicitBucketBoundaries`** takes variadic `float64`, not a slice. Use `defBuckets...` to spread the slice.

## Relevant Files
- `internal/metrics/otel.go`: All OTel instrument definitions (counters, histograms, updowncounters, observable gauges).
- `internal/metrics/kubernetes.go`: `RegisterKubernetesGaugeCallbacks` — populates observable gauges from K8s API.
- `internal/observability/observability.go`: `NewTelemetry` — creates Prometheus exporter + MeterProvider. Wireup for OTel on controller-runtime metrics registry.
- `internal/engine/helm_sdk_renderer.go`: instrumented `Render()` with duration/errors/total metrics.
- `internal/api/auth/middleware.go`: instrumented authn/authz with `AuthAttempts`, `AuthFailures`, `AuthzDenials`, `AuthzDecisions`.
- `internal/source/git.go`: instrumented `Resolve()` with `GitOperations`, `GitErrors`, `GitDuration`.
- `internal/controller/pipelines/release_controller.go`: instrumented `patchReleaseStatus` with `ReleaseTransitions`, `applyManifestsForCluster` with `SyncDuration` + `SyncErrors`.
- `internal/api/events/broker.go`: instrumented `Subscribe`/`Unsubscribe` (SSEConnections up/down), `Publish` (EventsPublished + topic attr).
- `cmd/main.go`: all `run*Mode` functions with `NewTelemetry`/`Shutdown`.
- `cmd/main_operator.go`: `runOperatorMode` with `RegisterKubernetesGaugeCallbacks`.
- `deploy/test-values.yaml`: image repository and tag, resource limits, gateway-api config.
- `.github/workflows/build-push.yml`: CI/CD build+push to ghcr.io on push to master.

## Commands
- `make test`, `make lint`, `just build/lint/test`
- `helm lint charts/chart/`
- `helm upgrade paprika-e2e charts/chart/ --namespace paprika-e2e --values deploy/test-values.yaml --wait --timeout 5m`
- `docker build --platform linux/amd64 -t ttl.sh/paprika-amd64:<tag> . && docker push ttl.sh/paprika-amd64:<tag>`
- `kubectl port-forward -n paprika-e2e svc/paprika-e2e-controller-manager-metrics-service <local_port>:8443`
- `kubectl port-forward -n paprika-e2e pods/<api-server-pod> <local_port>:8080` (metrics) or `:3000` (UI)
- `curl -s http://localhost:<port>/metrics | grep 'otel_scope_name="paprika"'`
- `source .env && make omega-apply`
- `kubectl --kubeconfig=terraform/omega-oidc.kubeconfig get nodes`
