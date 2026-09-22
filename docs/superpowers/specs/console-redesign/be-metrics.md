# Backend map: metrics, observability, health, grafana

Scope: `/Users/benebsworth/projects/paprika/internal/metrics`, `internal/observability`,
`internal/health`, `grafana/`, plus the outbound-metrics question and the
`docs/superpowers/plans/2026-07-11-observability-sources-golden-signals.md` plan.

**Headline finding: Paprika has ZERO ability to read metrics from anywhere.**
Everything under `internal/metrics` and `internal/observability` is *self*-instrumentation
(push/pull of Paprika's own telemetry outward). There is no Prometheus query client, no
metrics-server client, no kube-state-metrics/node-exporter scraper, no cAdvisor reader.
The plan that would have added one is written in full and **0 of its 131 steps are done**.

---

## 1. `internal/metrics` — what Paprika EMITS

Three parallel instrumentation systems coexist in this one package.

### 1a. Raw Prometheus client collectors — `internal/metrics/metrics.go`

Package doc line 1. All are package-level `prometheus.*Vec` vars declared in the `var (...)`
block at lines 15–205. Registered by `RegisterCollectors(reg prometheus.Registerer) error`
at **metrics.go:236** (defaults to controller-runtime's `metrics.Registry` when `reg == nil`);
the registration list is `allCollectors` at **metrics.go:207–231**.

| Metric name | Type | Labels | Decl line |
|---|---|---|---|
| `paprika_pipeline_duration_seconds` | HistogramVec (DefBuckets) | pipeline, namespace | 17 |
| `paprika_pipeline_phase_total` | CounterVec | pipeline, namespace, phase | 26 |
| `paprika_release_duration_seconds` | HistogramVec | release, namespace, target_stage | 34 |
| `paprika_release_phase_total` | CounterVec | release, namespace, phase | 43 |
| `paprika_canary_step_total` | CounterVec | release, namespace, stage | 51 |
| `paprika_canary_weight_current` | GaugeVec | release, namespace, stage | 59 |
| `paprika_analysis_check_total` | CounterVec | release, namespace, check_type, result | 67 |
| `paprika_rollout_canary_step_total` | CounterVec | rollout, namespace | 75 |
| `paprika_rollout_canary_weight_current` | GaugeVec | rollout, namespace | 83 |
| `paprika_rollout_phase_total` | CounterVec | rollout, namespace, phase | 91 |
| `paprika_application_phase_total` | CounterVec | application, namespace, phase | 99 |
| `paprika_application_reconcile_duration_seconds` | HistogramVec | application, namespace | 107 |
| `paprika_prune_total` | CounterVec | app, namespace, kind | 116 |
| `paprika_out_of_sync` | GaugeVec | app, namespace | 124 |
| `paprika_prunable` | GaugeVec | app, namespace | 132 |
| `paprika_api_request_duration_seconds` | HistogramVec | method, path, status_code | 140 |
| `paprika_api_request_total` | CounterVec | method, path, status_code | 149 |
| `paprika_reconcile_total` | CounterVec | controller, result | 157 |
| `paprika_reconcile_duration_seconds` | HistogramVec | controller | 165 |
| `paprika_coordinator_replicas` | Gauge | — | 174 |
| `paprika_coordinator_heartbeat_seconds` | Histogram | — | 179 |
| `paprika_coordinator_heartbeat_failures_total` | Counter | — | 185 |

Helpers: `Timer(clock.Clock) time.Time` (metrics.go:250) and
`Since(clock.Clock, time.Time) float64` (metrics.go:259) — clock-injectable elapsed time.

Call-site density (`rg -o "metrics\.[A-Z]\w*"` outside the package, non-test):
`ReleasePhaseTotal` 21, `ReconcileDuration` 10, `ReconcileTotal` 8, `PipelinePhaseTotal` 4,
everything else 1–2. So most collectors are wired at exactly one site.

### 1b. OpenTelemetry instruments — `internal/metrics/otel.go`

`var meter = otel.Meter("paprika")` (otel.go:8). Instruments are created eagerly at package
init via `mustCounter` / `mustHistogram` / `mustGauge` / `mustUpDownCounter`
(otel.go:113–145) — these **panic** on error. Bucket sets: `defBuckets` (seconds, 0.005→60),
`msBuckets` (1→60000 ms), `itemBuckets` (0→5000 items), otel.go:109–111.

- Render: `paprika.render.duration|errors|total` (otel.go:11–20)
- Sync: `paprika.sync.total|errors|duration`, `paprika.sync.last_timestamp` (otel.go:23–35)
- Auth: `paprika.auth.attempts|failures`, `paprika.authz.denials|decisions` (otel.go:38–51)
- API list: `paprika.api.list.duration|errors|items`, `paprika.api.cache.sync.duration` (otel.go:54–67)
- Git/source: `paprika.git.operations|errors|duration`, `paprika.source.resolve.total|errors` (otel.go:70–83)
- SSE/events: `paprika.sse.connections` (UpDownCounter), `paprika.events.published` (otel.go:86–91)
- Release/app gauges: `paprika.release.transitions`, `paprika.applications.active`,
  `paprika.applications.by_phase`, `paprika.releases.active`, `paprika.releases.by_phase` (otel.go:94–107)

### 1c. Kubernetes-derived observable gauges — `internal/metrics/kubernetes.go`

`RegisterKubernetesGaugeCallbacks(c client.Client) error` at **kubernetes.go:62** registers
an OTel callback that, on each collection, does `c.List(&ApplicationList)` and
`c.List(&ReleaseList)` and reports counts + per-phase breakdown
(`observeApplications` kubernetes.go:13, `observeReleases` kubernetes.go:35;
`isTerminalReleasePhase` kubernetes.go:76). Wired once, at **cmd/main_operator.go:245**.

**This is the only place Paprika "reads" anything to build a metric — and it reads its own
CRDs from its own API server. No node, pod, container, CPU or memory data is touched.**

### 1d. Fleet index instruments — `internal/metrics/fleet.go`

A hand-rolled instrument struct `fleetInstruments` (fleet.go:57–67), constructed at package
init: `var defaultFleetInstruments = mustNewFleetInstruments(meter)` (fleet.go:69).

Instruments (fleet.go:71–154): `paprika.fleet.index.build.duration`,
`paprika.fleet.index.update.duration`, `paprika.fleet.query.duration`,
`paprika.fleet.query.results`, `paprika.fleet.index.items` (observable gauge),
`paprika.fleet.index.generation` (observable gauge),
`paprika.fleet.index.rebuild.failures`.

Public API: `RecordFleetIndexBuild` (175), `RecordFleetIndexUpdate` (191),
`RecordFleetIndexState` (209, CAS-guarded monotonic generation, 213–230),
`RecordFleetRebuildFailure` (234), `RecordFleetQuery` (250).

**Cardinality discipline is enforced in code and is a repo-wide norm worth copying.**
Attribute values are closed enums — `FleetOperation` (16–19), `FleetQueryKind` (24–29),
`FleetOutcome` (34–39), `FleetCacheOutcome` (44–48) — each normalized through
`normalizeFleet*` (fleet.go:294–327) to `"unknown"` rather than passed through. Numeric
attribute `active_dimension_count` is clamped to 0–9 (fleet.go:282). Application/project
names, filters, cursors, endpoints and query text are deliberately never attributes. The
plans repeat this as a hard test requirement (e.g. plan `enterprise-fleet-console.md:607`).

---

## 2. `internal/observability` — OTel SDK bootstrap + audit, NOT "observability sources"

Package doc: *"provides tracing, audit logging, and event recording."* It has nothing to do
with the ObservabilitySource CRD or golden signals — the naming collision is a trap.

`internal/observability/observability.go` (18 KB):
- `Config` struct (**:49**) and `ConfigFromEnv()` (**:67**) — pure `OTEL_*` env: endpoint,
  protocol (grpc default), insecure (default **true**), cert path, headers, sampler,
  propagators, service name, `PAPRIKA_VERSION`, batch timeout 5s, queue 2048.
- `Telemetry` struct (**:86**) holding tracer + `sdktrace.TracerProvider` +
  `sdkmetric.MeterProvider` + `sdklog.LoggerProvider`.
- `NewTelemetry(ctx, cfg) *Telemetry` (**:154**) — the composition root. Always creates a
  **Prometheus exporter registered on controller-runtime's `ctrlmetrics.Registry`**
  (observability.go:158–161), so all OTel instruments in §1b–1d surface on the same
  `/metrics` scrape endpoint as the `paprika_*` Prometheus collectors and the
  `controller_runtime_*` built-ins. If `OTEL_EXPORTER_OTLP_ENDPOINT` is empty it returns
  early with metrics-only (observability.go:178–185). Otherwise it adds OTLP traces
  (batcher), OTLP metrics (`PeriodicReader`, 60s), and OTLP logs.
- `buildResource` (:245), `buildTraceExporter` (:281), `buildMetricExporter` (:325),
  `buildLogExporter` (:370), `buildSampler` (:411), `setPropagator` (:433).
- `EventRecorder` (**:499**) wrapping `record.EventRecorder`: `Normal` (:509) / `Warning` (:517)
  → Kubernetes Events.
- `AuditLogger` (**:525**), `NewAuditLogger(enabled bool, clk clock.Clock)` (:531),
  `Log(action, resource, namespace, name, user, details)` (:539).
- Correlation ID context plumbing: `CorrelationIDKey` (:556), `WithCorrelationID` (:559),
  `CorrelationID` (:564).

`internal/observability/reconcile.go`: `ReconcileSpan(ctx, controller, req)` (**:33**) —
top-level per-reconcile span, relies on the noop tracer when OTLP is unconfigured.

`otelzap_bridge_test.go` tests the `go.opentelemetry.io/contrib/bridges/otelzap` core
contract; there is no production `otelzap_bridge.go` — the bridge is assembled by callers
from `Telemetry.LoggerProvider()` (observability.go:116).

Wiring: `NewTelemetry` is called once per binary/mode — `cmd/main.go:506` (api),
`:752` (webhook), `:827` (repo-server), `:864` (agent), `cmd/main_operator.go:114`,
`cmd/cloud-run/main.go:143`. `metrics.RegisterCollectors(crmetrics.Registry)` at
`cmd/main.go:160` and `cmd/cloud-run/main.go:82`. Metrics bind address flag:
`cmd/main.go:245`, `cmd/cloud-run/main.go:101` (default disabled, `:0`/`0`).
`internal/api/metrics_handler.go:15` `MetricsHandler()` returns `promhttp.Handler()`;
`MetricsMiddleware` (:24) records `paprika_api_request_{duration_seconds,total}` and
truncates the path label at 64 chars (`normalizePath` :48) — note this is **not** a route
template, so raw paths become label values (cardinality hazard already present).

---

## 3. `internal/health` — Kubernetes object status, no metrics

- `internal/health/resources.go` — `ResourceHealthChecker` (**:19**) wrapping a
  `client.Client`. `Check(ctx, kind, name, namespace)` (**:29**) switches on kind:
  `checkDeployment` (:47) compares `Status.AvailableReplicas` / `UpdatedReplicas` against
  `Spec.Replicas` → `Healthy|Progressing|Missing`; `checkService` (:70), `checkIngress` (:79),
  `checkCronJob` (:87); ConfigMap/Secret hardcoded `Healthy`; everything else `Unknown`.
- `internal/health/cel.go` — `CELEvaluator` (**:23**) evaluating `paprikav1.HealthCheck` CEL
  expressions with an optional HTTP probe: `Evaluate` (:53), `doHTTPProbe` (:70),
  `evalExpression` (:124), `interpretResult` (:187), `AggregateHealth` (:215).
  `doHTTPProbe` is the only outbound HTTP in this package — an application liveness probe,
  not a metrics query.

**No CPU/memory/utilization data anywhere in `internal/health`.**

---

## 4. `grafana/` and Helm Prometheus assets

`grafana/overview.json` — a single 5-panel dashboard, uid `paprika-overview`, tags
`["paprika"]`, one `namespace` template var from
`label_values(paprika_application_phase_total, namespace)`. Panels:
1. Reconcile Rate — `sum(rate(controller_runtime_reconcile_total[5m])) by (controller)`
2. Reconcile Error Rate — `controller_runtime_reconcile_errors_total`
3. P95 Reconcile Latency — `histogram_quantile(0.95, …controller_runtime_reconcile_time_seconds_bucket…)`
4. Application Phases — `sum(paprika_application_phase_total) by (phase)`
5. Release Phases — `sum(paprika_release_phase_total) by (phase)`

Three of five panels use controller-runtime built-ins, not Paprika metrics. Nothing about
capacity, cost, traffic, or clusters.

Helm: `charts/chart/templates/prometheus/` has ServiceMonitors for api-server,
controller-manager, repo-server, webhook-receiver, plus `prometheusrules.yaml`.
`charts/chart/values.yaml:882` `metrics.*` (port, secure, bind address,
`metrics.serviceMonitor`), `:911` `prometheus.*`, `:917` `grafana.dashboards` with sidecar
label `grafana_dashboard: "1"`.

**Dangling alert rules** — `prometheusrules.yaml` alerts on four metric names that no Go
code emits (verified absent from every `.go` file):
`paprika_cluster_phase` (:68), `paprika_cache_errors_total` (:86),
`paprika_webhook_errors_total` (:95), `paprika_ratelimit_denials_total` (:104).
`PaprikaOOMKilled` (:77) depends on cAdvisor's `container_memory_failures_total`, i.e. on
the *user's* Prometheus, not on Paprika. Real rules: `PaprikaReleaseFailed` (:50),
`PaprikaApplicationDegraded` (:59), `PaprikaApiServerHighRequestLatency` (:113),
`PaprikaReconcileErrors` (:32), `PaprikaReconcileLatencyHigh` (:41).

---

## 5. CRITICAL: can Paprika READ metrics from a cluster? — **No.**

Exhaustive negative evidence:

| Capability | Status |
|---|---|
| Prometheus HTTP API client (`prometheus/client_golang/api`, `v1.NewAPI`) | **Absent.** `go.mod:31` has `github.com/prometheus/client_golang v1.23.2` but only the *instrumentation* half is imported (`prometheus`, `promhttp`). No `/api/v1/query` string exists in any `.go` file. |
| PromQL parser (`prometheus/promql/parser`) | **Absent.** `github.com/prometheus/prometheus` is not a dependency. |
| metrics-server / `metrics.k8s.io` | **Absent.** `k8s.io/metrics` is in neither `go.mod` nor `go.sum`. No `PodMetrics`/`NodeMetrics` types anywhere. |
| kube-state-metrics / node-exporter scraping | **Absent.** Only hits are a demo sidecar image `prom/node-exporter:v1.7.0` in `charts/demo-app/values.yaml:34`. |
| Node listing / `Allocatable` / capacity | **Absent.** No `corev1.NodeList` read anywhere in `internal/`. The single `resource.Quantity` use is `parseQuantity` in `internal/engine/diff.go:442`, for manifest *diffing*. `.Resources.Requests` is never summed. |
| Thanos / VictoriaMetrics / Datadog / New Relic | **Absent.** |
| Investigator (`internal/investigator/`) | Detectors read manifests, Events and pod logs only (`events_source.go`, `logs_source.go`, `manifest_source.go`). `registry_default.go:10` and `registry.go:4,8` describe a Prometheus source as an *optional future plugin*. Nothing implements it. |

The closest thing to reading runtime signals, and it is deliberately fake:

- `internal/analysis/analysis.go` — `CELAnalyzer` (**:30**), `RunChecks` (**:52**).
  - `runHTTPCheck` (:83) — N sequential GETs against `check.URL`, success ratio vs threshold.
  - `runPodMetricsCheck` (**:148**) dispatches on `check.Metric`:
    - `"restartRate"` → `checkRestartRate` (**:177**): `Pods(ns).List` with hardcoded
      `LabelSelector: "app.kubernetes.io/name=demo-app"`, sums `ContainerStatuses[].RestartCount`,
      divides by pod count. Demo-grade, hardwired to the sample app.
    - `"errorRate"` → `checkPodStatusRate` (**:206**): same hardcoded demo-app selector;
      "error rate" = fraction of container statuses with `State.Terminated.ExitCode != 0`.
      **This is not an HTTP error rate.**
    - `"latencyP99"` → hardcoded stub at **analysis.go:163–168**:
      `Result{Passed: true, Message: "latencyP99 check passed (no metrics server available, assuming pass)"}`.
      Latency analysis is a no-op that always passes.

So the only "metrics" Paprika can currently observe about a workload are pod restart counts
and container exit codes, from the Kubernetes API, for one hardcoded label selector.

---

## 6. `docs/superpowers/plans/2026-07-11-observability-sources-golden-signals.md` — planned vs. existing

**Status: 0 of 131 checkboxes complete** (`grep -c "^- \[x\]"` → 0, `"^- \[ \]"` → 131).
The plan file's only commit is `f2c873f feat: add enterprise fleet deployment console (#41)`,
i.e. it landed as a document alongside Plan 1 and was never executed.

### What was planned (15 tasks, 2 chunks)

Goal (plan:5): *"Add a project-bound ObservabilitySource CRD and secure Prometheus provider
that powers normalized golden signals, fleet traffic sizing, deterministic rollout analysis,
and investigator evidence."* Approved spec:
`docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md`.

Planned packages (plan:25–33) — **none exist**:
- `api/observability/v1alpha1/` — ObservabilitySource CRD. Absent (`api/` has clusters, core,
  featureflags, pipelines, policy, rollouts).
- `internal/metricprovider/` + `internal/metricprovider/prometheus/` — provider contracts,
  PromQL AST compilation, endpoint policy, transport, auth, limits, decoding, normalization,
  fleet projection, source checking, telemetry, audit. Absent.
- `internal/metricruntime/` — the single composition root that constructs the Prometheus
  factory (plan:456). Absent.
- `internal/apicache/` — shared cache/client bootstrap. Absent.
- `internal/controller/observability/` — source health reconciliation. Absent.
- `internal/api/signals_handler.go` — the `QueryApplicationSignals` RPC handler. Absent.
- `ui/src/components/applications/workspace/` golden-signal panels.

Key design points from the plan + spec (spec ~lines 270–345):
- Four typed `SignalDefinition`s per source. Only **request rate** may carry a
  `fleetExpression`. The four golden signals are request rate, error rate, latency, saturation.
- `MetricProvider` interface: `Health`, `QueryInstant`, `QueryRange`, `QueryFleetInstant`;
  plus `MetricProviderFactory{ProviderType, New(ctx, source, credentials)}` (spec:311).
- **The browser never submits PromQL.** Operators configure PromQL on the CRD; the server
  parses it with `promql/parser`, injects server-owned equality matchers into every vector
  selector, rejects conflicting user matchers, then serializes and reparses. `${window}` is
  the only textual variable and only in range-duration positions.
- Correlation labels: application, namespace, project, stage, cluster. A source only
  advertises the `fleet` capability when the compiled fleet expression groups by all five.
- Bindings: `AppProject.spec.defaultObservabilitySource`, `Application.spec.observability.sourceRef`,
  `ApplicationPromotionStage.observabilitySourceRef`, `StageSpec.ObservabilitySourceRef`,
  `MetricAnalysisCheck.sourceRef`. Fail-closed; analysis without an effective source → `Error`.
- Auth types `none|bearer|basic|mtls`, fixed Secret keys (`token`; `username`/`password`;
  `tls.crt`/`tls.key`/`ca.crt`), same-namespace only, `AppProject.spec.allowedCredentialSecrets`
  allowlist, URL userinfo forbidden.
- Security limits: HTTP(S) only, admin DNS/CIDR allowlist deny-all by default, custom dialer
  re-validating every resolved address (DNS-rebinding defence), loopback/link-local/metadata
  ranges denied; timeouts 5–30s; 4 concurrent queries/source; interactive caps of 200 series,
  1000 points/series, 10 MiB, 7-day range, step ≥ `max(15s, range/1000)`; 30 req/min per
  principal+source with burst 10; ≤32 concurrent provider calls process-wide;
  `ResourceExhausted` + retry metadata on overload.
- `FleetMetricsProjector` refreshes request-rate weights per healthy source every 60s ± jitter
  with **one** fleet query (never one per Application), keyed
  `(project ns, project, app ns, app, stage, cluster)`, capped 20,000 series / 20 MiB.
- Client cache keyed by source UID/resourceVersion + Secret resourceVersion; bounded-TTL
  result cache with singleflight; partial results (one failed signal must not discard others).
- Task 10 adds a **unary** `QueryApplicationSignals` RPC whose request carries Application
  identity, stage, signal enums, start/end/step/window — *never* source identity or PromQL.
- Task 9 makes `audit.Auditor.Record` fallible and adds a sink-failure counter; telemetry
  attributes restricted to provider health/duration/failure-kind/series-count-bucket/
  truncation/cache-outcome, with tests that *reject* names, endpoints, credentials and PromQL.
- Chunk 2 (Tasks 12–15) replaces the `internal/analysis` CEL/pod-stat checks with typed
  metric analysis, wires typed outcomes into AnalysisRun/Release/Rollout, and gates the
  legacy unsafe analysis behind a preflight + audited one-release compatibility flag.

### What actually exists: only the *seams*

The prerequisite plan (enterprise fleet console, Plan 1) landed and deliberately left
provider-neutral holes. These are real, tested, and the correct attachment points:

1. **`internal/fleet/optional_source.go`** — `OptionalSourceProjector` (**:16**, methods
   `Prototype() client.Object`, `Summarize(client.Object) (SourceSummary, error)`,
   `Bindings(app, project, stages) []types.NamespacedName`) and `OptionalSourceStore`
   (**:29**). Comment at :14–15: *"the provider-neutral seam implemented by a later
   observability plan. Plan 1 supplies nil and imports no future CRD package."*
   `projectOptionalSourceBinding` (**:57**) sets `ObservabilityConnection = NotConfigured`
   when the projector is nil (:66). Cross-project binding → `Unhealthy` + projection error
   (:104–108). Bindings must be same-namespace (`normalizeOptionalBindings` :119).
2. **`internal/fleet/model.go`** — `ApplicationSummary.EffectiveObservabilitySource` (:163),
   `.ObservabilityConnection` (:164), `.ObservabilityBindings` (:168);
   `SourceSummary{Identity, Project, Connection}` (:195); `ConnectionState` enum (:120–128:
   Unspecified/Healthy/Unhealthy/Disabled/NotConfigured).
3. **`internal/fleet/status.go`** — `connectionReferenceObservability` (:15) already counts an
   unhealthy observability source toward the attention ranking
   (`unhealthyConnectionCount` :248, specifically :255–260).
4. **`internal/fleet/map.go`** — `SizeMetric` enum (:26–31) with `SizeMetricRequestRate = 2`,
   `TargetWeightKey` (**:43**), and `WeightReader{ RequestRate(TargetWeightKey) (float64, bool) }`
   (**:50–54**) — *"the optional future seam for a bounded in-memory request rate cache."*
   `FleetMapLeaf` carries `ResourceWeight`, `RequestRateWeight`, `EffectiveWeight`,
   `UsedResourceFallback` (:86–88, :301).
   **But `internal/fleet/reader.go:109` and `:~130` call `snapshot.QueryMap(scope, query, nil)` /
   `QueryMatrix(..., nil)`** with the comment *"delegates without a WeightReader until the
   future metrics cache is injected"* (reader.go:93, :114). So selecting
   `FLEET_SIZE_METRIC_REQUEST_RATE` today always silently falls back to resource count.
5. **Proto already reserves the shape**: `proto/paprika/v1/api.proto` has
   `FleetSizeMetric` with `FLEET_SIZE_METRIC_REQUEST_RATE = 2` (:929–932),
   `request_rate_weight` on map leaves (:1088) and matrix cells (:1124),
   `effective_weight` (:1089), and
   `effective_observability_source` / `observability_connection` on `ApplicationSummary`
   (:1016–1017). The wire format is ready; nothing fills it.
6. `internal/investigator/registry.go` `DataSource` extension point (:4, :8).

There is **no** `QueryApplicationSignals` RPC. The full RPC list (api.proto:1146–1186) has
40 RPCs and none of them return metrics, capacity, or cost.

---

## 7. Adjacent facts the redesign needs (found while mapping)

**A Cluster CRD *does* exist**, even though the proto has no Cluster message:
- `api/clusters/v1alpha1/cluster_types.go`: `ClusterSpec{DisplayName, Mode, Server,
  KubeconfigSecretRef, ServiceAccount, Labels map[string]string, HealthCheck{Interval,Timeout},
  Disabled, ConnectionTimeout}` and `ClusterStatus{ObservedGeneration, Phase, Conditions,
  LastHealthCheckTime, Version, AgentInfo{Version, Connected, Address}}`.
- `internal/controller/clusters/cluster_controller.go`: `checkHealth` (**:144**) builds a
  client from the kubeconfig Secret and calls `cli.Discovery().ServerVersion()` (**:164**),
  storing `version.GitVersion`. `updatePhase` (**:170**) requeues every 30s (or
  `spec.healthCheck.interval`).
- **So k8s version + connection phase + display name + arbitrary spec labels are already
  available server-side. Node count, region, pod counts, CPU/memory are not** — the
  controller never lists Nodes or Pods.
- `internal/fleet/connection_projection.go:34` `projectClusterSummary` reduces a Cluster to
  `ClusterSummary{Identity, DisplayName, Connection}` (model.go:188) — it deliberately drops
  `Status.Version`. Snapshot holds `Clusters map[ClusterKey]ClusterSummary` (snapshot.go:18).
- The proto exposes clusters only as opaque `FleetObjectKey` + label + connection state
  (api.proto:978, 991–995, 1003–1004). No `ListClusters` RPC exists.

`GetSystemStatusResponse` (api.proto:1048–1057) returns index generation, totals, health
buckets, sync buckets and an attention list — no infrastructure or capacity data.

---

## 8. Conclusion — what must be built or integrated

### 8a. Per-app latency / error rate / request rate (golden signals)

There is **no path to this data today** and no shortcut. Paprika does not run a metrics
pipeline and should not start one — the design already decided (spec, and
`docs/superpowers/specs/2026-06-30-comprehensive-otel-design.md:70`) that Paprika *sends*
telemetry and *queries* the operator's existing Prometheus. Required work is essentially
Chunk 1 of the unexecuted plan:

1. `api/observability/v1alpha1` ObservabilitySource CRD + deepcopy + CRD manifests +
   scheme registration in `cmd/main.go`, `cmd/main_operator.go`, `cmd/cloud-run/main.go`,
   and the cached warm-object set.
2. `internal/metricprovider` provider-neutral contracts (`MetricProvider`,
   `MetricProviderFactory`, `SignalRequest/Result`, `FleetSignalRequest/Result`, canonical
   signal + unit enums, typed failure kinds, capabilities).
3. `internal/metricprovider/prometheus`: new deps `github.com/prometheus/prometheus`
   (parser) — plan:106 warns to pin `golang.org/x/time@v0.15.0` so the existing version is
   not downgraded — plus endpoint policy, IP-validating dialer, TLS/auth transport,
   AST matcher injection, bounded decode, normalization.
4. Binding resolution + credential loading (fail-closed), admission webhook, and a source
   health controller writing `status.phase/capabilities/lastCheckedAt/responseTime`.
5. `internal/metricruntime` composition root + client/result caches + rate limits, wired
   into all three API runtimes with readiness and shutdown.
6. Additive `QueryApplicationSignals` unary RPC + `internal/api/signals_handler.go` with
   per-signal partial results and `NotConfigured|NoData|Stale|Unavailable` states.
7. Optional: implement `fleet.OptionalSourceProjector` and a `fleet.WeightReader` so
   `FLEET_SIZE_METRIC_REQUEST_RATE` and `ObservabilityConnection` stop being dead fields.

Estimated shape: ~15 new packages/files in Go plus one CRD. This is the single largest
backend item in the redesign and it is a security-sensitive surface (SSRF, credential
handling, cardinality, DoS) — the plan's constraints are not optional polish.

Interim honest fallback if this is out of scope for the redesign: return
`NOT_CONFIGURED` for latency/error/request-rate and have the UI render a
"connect an observability source" affordance rather than fabricating numbers. Note that
`internal/analysis` `latencyP99` already silently returns pass — that stub should be treated
as a bug to fix, not a pattern to copy.

### 8b. Per-cluster CPU / memory used vs. requested vs. allocatable

Note this is a **different problem from 8a** and the plan does not cover it — the plan's four
signals are per-*application* golden signals, not cluster capacity. Two viable routes:

**Route A — Kubernetes API only (no Prometheus dependency). Recommended first step.**
- *allocatable* and *capacity*: list `corev1.Node` on the target cluster,
  sum `node.Status.Allocatable["cpu"|"memory"]` and `.Capacity`. Also yields **node count**,
  and **region** via well-known labels `topology.kubernetes.io/region` / `.../zone`
  (gap-analysis item 1).
- *requested*: list `corev1.Pod` (field-select `status.phase!=Succeeded,status.phase!=Failed`),
  sum `container.Resources.Requests` across containers + `max(initContainer requests)`
  per the scheduler's formula. Also yields **pod counts** (running/pending/failed).
- *used*: requires `metrics.k8s.io` (metrics-server) — add `k8s.io/metrics` and use
  `NodeMetricses().List()` for node-level usage, `PodMetricses().List()` for per-app usage.
  Must degrade gracefully: metrics-server is not guaranteed installed, and the repo's own
  session logs show it missing in the dev cluster (`session-ses_120e.md:994`:
  *"the server could not find the requested resource (get pods.metrics.k8s.io)"*).
- Where to put it: a `ClusterCapacityProjector` reconciled by
  `internal/controller/clusters/cluster_controller.go` on its existing 30s health-check
  requeue, writing summary numbers into `ClusterStatus` (additive fields:
  `nodeCount`, `region`, `podCount`, `cpuAllocatable/Requested/Used`,
  `memoryAllocatable/Requested/Used`, `capacityObservedAt`). That reuses the existing
  kubeconfig-Secret → `rest.Config` path (`cluster_controller.go:~100–145`) and the existing
  `Cluster` reconcile loop, and keeps the API server doing zero live fan-out reads.
  Then extend `fleet.ClusterSummary` (model.go:188) + `projectClusterSummary`
  (connection_projection.go:34) and add a `Cluster` proto message + `ListClusters`/
  `GetCluster` RPCs.
- Cost: on a large cluster a full Pod list is expensive. Do it in the cluster controller on
  an interval with an informer or a paged list, never per API request.

**Route B — via the same Prometheus source as 8a**, using
`kube_node_status_allocatable`, `kube_pod_container_resource_requests` (kube-state-metrics)
and `container_cpu_usage_seconds_total` / `container_memory_working_set_bytes` (cAdvisor).
This needs kube-state-metrics *and* cAdvisor scraping and adds a hard dependency on the
user's Prometheus for basic inventory — which the enterprise plan explicitly refuses
(`connection-management-authorized-events.md:636,707`: a Prometheus outage must not block
fleet inventory or resource inspection). **Prefer Route A for capacity, Route B/8a for
golden signals**, and let the UI mark `used` as unavailable when metrics-server is absent.

### 8c. Everything else in the gap list

Not covered by any of these packages. Cost (item 3) has no source of truth anywhere in the
repo — it would require either a cloud billing integration or a rate-card × (allocatable or
requested) computation layered on 8b. Pipeline CPU-minutes / cache-hit-rate (item 6) would
be new `paprika.*` emissions from the pipeline controller *plus* a store, since Paprika
retains no history — worth checking whether the pipeline CRD status already carries per-step
durations before designing a store.
