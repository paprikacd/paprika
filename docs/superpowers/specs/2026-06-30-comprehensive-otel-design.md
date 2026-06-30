# Comprehensive OpenTelemetry Integration — Design

## Status
Draft, 2026-06-30. Target branch: `feature/otel`.

## Goal
Transform paprika from "Prometheus-first with a vestigial OTel tracing shim" into a fully instrumented OTel-native platform: configurable exporter, W3C context propagation across all process boundaries, auto-instrumentation for HTTP/gRPC, reconcile spans on all controllers, OTLP metrics dual-export alongside Prometheus, trace-ID correlation in logs, and Helm chart wiring so tracing is actually ON in production.

## Audit findings (current state)
- **Tracing SDK**: OTLP/gRPC only, hardcoded `WithInsecure()`, `AlwaysSample`, 2 resource attrs (`service.name`+`service.version`), no propagator setup, no resource detectors, no batch tuning.
- **Controller spans**: 2 of ~15 reconcilers (`ReleaseReconciler`, `ApplicationReconciler`), top-level span only, no child spans for render/apply/diff.
- **API server**: `connectrpc.com/otelconnect` is an indirect dep but NEVER imported. No `otelhttp` middleware. No inbound trace context extraction → distributed traces broken end-to-end.
- **Metrics**: 17 Prometheus collectors, dual-export via controller-runtime registry + UI `/metrics`. No OTLP metrics exporter. `MetricsMiddleware` is dead code (defined but never wired).
- **Logging**: zap/logr, no `otelzap` bridge, no trace-ID in logs. Audit logger discards context.
- **Helm chart**: No OTel collector, no `OTEL_EXPORTER_OTLP_ENDPOINT` env var in any deployment → tracing is always-off when deployed via Helm.
- **Grafana**: Dashboard ConfigMap is broken (`.Files.Get` references a non-existent path inside the chart).

## Architecture

### Chunk 0: OTel SDK hardening
Rewrite `internal/observability/observability.go` to be fully configurable:
- **Exporter protocol**: support OTLP gRPC AND HTTP (configurable via env/flag).
- **TLS**: configurable insecure/tls toggle + CA cert path + headers.
- **Sampler**: configurable (always-on, always-off, trace-id-ratio, parent-based-always) with ratio parameter.
- **Batch processor**: configurable batch timeout, queue size, max export batch size.
- **Resource detection**: add k8s detector (pod name, namespace, node, deployment), host detector (hostname, arch, OS), process detector (pid, runtime).
- **Propagator**: explicitly set `W3C TraceContext + Baggage` via `otel.SetTextMapPropagator()`.
- **New env vars**: `OTEL_EXPORTER_OTLP_PROTOCOL` (grpc/http), `OTEL_EXPORTER_OTLP_INSECURE` (true/false), `OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER` (always_on/always_off/traceidratio/parentbased_traceidratio), `OTEL_TRACES_SAMPLER_ARG` (ratio 0.0-1.0), `OTEL_PROPAGATORS` (tracecontext,baggage), `OTEL_RESOURCE_ATTRIBUTES` (key=value pairs).

### Chunk 1: Auto-instrumentation (API server + HTTP)
- **`otelconnect.NewInterceptor()`** on every Connect RPC handler (cmd/main.go, cmd/main_operator.go, cmd/cloud-run/main.go). This gives spans for every RPC call AND extracts/injects W3C trace context across HTTP/2.
- **`otelhttp.NewHandler()`** wrapping the HTTP mux (SSE, webhook receiver, health probes, /metrics).
- **`otelhttp.NewTransport()`** on outbound HTTP clients (health CEL probes, webhook notifications, agent HTTP calls).

### Chunk 2: Controller reconcile spans (all 15)
Add a reusable `ReconcileSpan(ctx, reconcilerName, req)` helper in `internal/observability/` that wraps any reconcile call with a top-level span. Wire into every reconciler's `Reconcile()` method. Add child spans for the most expensive sub-operations:
- `render` — Helm/Kustomize rendering
- `apply` — manifest application
- `diff` — diff computation
- `gates` — governance/conftest evaluation
- `analysis` — AnalysisRun checks

### Chunk 3: OTLP metrics dual-export + wire MetricsMiddleware
- Add `otlpmetricgrpc`/`otlpmetrichttp` exporter alongside Prometheus, configurable via `OTEL_EXPORTER_OTLP_PROTOCOL`.
- Use `sdkmetric.NewMeterProvider` with a `prometheus.Producer` reader that scrapes the existing Prometheus registry → exports via OTLP. This avoids re-instrumenting all 17 collectors.
- Wire the dead-code `MetricsMiddleware` into the API mux so `paprika_api_request_duration_seconds` / `paprika_api_request_total` actually fire.

### Chunk 4: Log/trace correlation (otelzap bridge)
- Replace the zap logger with `otelzap.NewCore(zapCore, otelzap.WithLoggerProvider(...))` so every log line includes `trace_id` + `span_id` in structured fields.
- Wire the audit logger to extract trace context from `ctx` and include `trace_id` in audit events.

### Chunk 5: Helm chart wiring + Grafana fix
- Add `otel:` values block to `charts/chart/values.yaml`:
  ```yaml
  otel:
    enabled: false
    endpoint: ""           # e.g. "otel-collector.observability.svc:4317"
    protocol: "grpc"       # grpc or http
    insecure: true
    sampler: "always_on"   # always_on, traceidratio, parentbased_traceidratio
    samplerArg: ""         # ratio for traceidratio
    headers: {}            # auth headers
  ```
- Conditionally set `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_INSECURE`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_PROPAGATORS` env vars in ALL deployment templates (manager, api-server, repo-server, webhook-receiver, agent).
- Add ServiceMonitors for api-server, repo-server, webhook-receiver, agent (currently only controller-manager has one).
- Fix the broken Grafana dashboard ConfigMap (copy `grafana/overview.json` into the chart, or use a ConfigMap-from-content approach).
- Add trace/Tempo datasource support to the dashboard.

## Non-goals (deferred)
- **OTel Collector deployment as a subchart** — paprika should SEND to an existing collector, not bundle one. Users bring their own (otel-collector, Grafana Agent, Datadog Agent, etc.).
- **OTLP log exporter** — OTel logs SDK for Go is still experimental. Defer until GA. Use otelzap bridge for trace-ID correlation in the meantime.
- **Custom OTel metrics (not derived from Prometheus)** — the dual-export approach reuses existing Prometheus collectors. Custom OTel-native metrics (histograms with exemplars, etc.) are a follow-up.
- **Auto-instrumentation for database/cache clients** (otelpgx, otelsql, otmongo) — paprika doesn't use direct DB connections (it's CRD-based), so this is moot until a database is added.
- **Profiling / continuous profiling** — orthogonal to OTel metrics/traces.
- **Alerting based on trace-derived metrics (RED metrics from spans)** — the collector can do this via the spanmetrics connector; paprika doesn't need to implement it.

## Testing
- **SDK config**: unit tests for each env var → exporter/sampler/batch/resource mapping. Table-driven.
- **Auto-instrumentation**: verify `otelconnect` interceptor creates spans by inspecting the registered handler chain. Integration test via envtest (call an RPC, verify span is recorded).
- **Controller spans**: verify each reconciler's `Reconcile` creates a span. Integration test.
- **Metrics dual-export**: verify OTLP metric exporter is registered alongside Prometheus. Unit test.
- **Helm chart**: `helm lint`, `helm template` with otel enabled/disabled. Verify env vars are conditionally set.

## Effort estimate
4-5 days, 6-7 commits. The most impactful single change is Chunk 1 (auto-instrumentation) — it fixes distributed tracing across all process boundaries in one shot.
