# Comprehensive OTel Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform paprika from vestigial OTel tracing into a fully instrumented OTel-native platform.

**Architecture:** Rewrite the SDK layer to be configurable, add auto-instrumentation (otelconnect + otelhttp) at all API boundaries, wrap all reconcilers with spans, add OTLP metrics dual-export, bridge zap logs with trace IDs, and wire it all through the Helm chart.

**Tech Stack:** Go, OpenTelemetry SDK v1.44+, otelconnect, otelhttp, controller-runtime, Helm.

**Spec reference:** `docs/superpowers/specs/2026-06-30-comprehensive-otel-design.md`.

---

## Conventions

- **Working directory:** `/Users/benebsworth/projects/paprika/.worktrees/otel`
- **After any Go change:** `bin/golangci-lint run` and `go test` before committing.
- **NEVER edit** auto-generated files. Run `make manifests generate` only if types change.

---

## Chunk 0: OTel SDK hardening

### Task 0.1: Rewrite `internal/observability/observability.go`

**Files:** Modify `internal/observability/observability.go`, `internal/observability/observability_test.go`

The current file has:
- Hardcoded `WithInsecure()`, `AlwaysSample`, gRPC-only, 2 resource attrs, no propagator.
- 251 lines.

Rewrite to support:

**Config struct:**
```go
type Config struct {
	OTLPEndpoint   string  // OTEL_EXPORTER_OTLP_ENDPOINT
	Protocol       string  // OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" (default) or "http"
	Insecure       bool    // OTEL_EXPORTER_OTLP_INSECURE
	CertificatePath string // OTEL_EXPORTER_OTLP_CERTIFICATE
	Headers        map[string]string // OTEL_EXPORTER_OTLP_HEADERS
	Sampler        string  // OTEL_TRACES_SAMPLER: always_on, always_off, traceidratio, parentbased_traceidratio
	SamplerArg     string  // OTEL_TRACES_SAMPLER_ARG: ratio 0.0-1.0
	Propagators    string  // OTEL_PROPAGATORS: "tracecontext,baggage" (default)
	ServiceName    string  // OTEL_SERVICE_NAME (default "paprika")
	ServiceVersion string  // PAPRIKA_VERSION (default "dev")
	BatchTimeout   time.Duration // default 5s
	MaxQueueSize   int           // default 2048
	ResourceAttrs  map[string]string // OTEL_RESOURCE_ATTRIBUTES
}
```

**ConfigFromEnv()** reads the standard `OTEL_*` env vars per the OTel specification.

**Key implementation points:**

1. **Exporter**: switch on Protocol — `"grpc"` → `otlptracegrpc`, `"http"` → `otlptracehttp`. Both support `WithEndpoint`, `WithInsecure`/`WithTLSCredentials`, `WithHeaders`, `WithTimeout`.

2. **Sampler**: switch on Sampler string:
   - `"always_on"` → `trace.AlwaysSample()`
   - `"always_off"` → `trace.NeverSample()`
   - `"traceidratio"` → `trace.TraceIDRatioBased(ratio)`
   - `"parentbased_traceidratio"` → `trace.ParentBased(trace.TraceIDRatioBased(ratio))`
   - default → `trace.AlwaysSample()` (backward compat)

3. **Batch processor**: `trace.WithBatcher(exporter, trace.WithBatchTimeout(cfg.BatchTimeout), trace.WithMaxQueueSize(cfg.MaxQueueSize))`.

4. **Resource**: start with `service.name` + `service.version`, then add:
   - Host attributes via `host.Detector()` from `go.opentelemetry.io/contrib/detectors/telemetrysdk`
   - Process attributes via `process.Detector()` from `go.opentelemetry.io/sdk/resource`
   - User-provided `ResourceAttrs` map
   - K8s attributes are harder (no stable Go k8s detector) — read from env vars / downward API:
     ```go
     if ns := os.Getenv("PAPRIKA_NAMESPACE"); ns != "" { attrs = append(attrs, semconv.K8SNamespaceName(ns)) }
     if pod := os.Getenv("PAPRIKA_POD_NAME"); pod != "" { attrs = append(attrs, semconv.K8SPodName(pod)) }
     ```

5. **Propagator**: `otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))`.

6. **Shutdown**: unchanged — close exporter, flush batch.

**Config resolution in cmd/main.go:**
- Replace the 3 inline env-var reads (lines 302-304) with `observability.ConfigFromEnv()`.
- Pass the full `Config` to `observability.NewTelemetry(cfg)`.
- Same for cloud-run (`cmd/cloud-run/main.go:135-152`).

**Tests:**
- Table-driven tests for each env var → config field mapping.
- Test sampler selection (always_on, always_off, traceidratio with ratio 0.5, parentbased).
- Test exporter protocol selection (grpc, http).
- Test resource attribute enrichment (service name, version, host attrs, k8s attrs from env).
- Test insecure vs TLS toggle.

### Steps:
- [ ] Step 1: Write `ConfigFromEnv` tests (table-driven, one case per env var).
- [ ] Step 2: Write sampler selection tests.
- [ ] Step 3: Rewrite `observability.go` with `Config`, `ConfigFromEnv`, configurable exporter/sampler/batch/resource/propagator.
- [ ] Step 4: Update `cmd/main.go` and `cmd/cloud-run/main.go` to use `ConfigFromEnv`.
- [ ] Step 5: Verify build + tests + lint.
- [ ] Step 6: Commit: `feat(otel): configurable SDK — exporter, sampler, TLS, resource detection, propagation`

---

## Chunk 1: Auto-instrumentation

### Task 1.1: Add `otelconnect` interceptor to all Connect RPC handlers

**Files:** Modify `cmd/main.go`, `cmd/main_operator.go`, `cmd/cloud-run/main.go`

In each file where `connect.WithInterceptors(...)` is called, add `otelconnect.NewInterceptor()`:

```go
import "connectrpc.com/otelconnect"

// In the handler construction:
otelInterceptor, err := otelconnect.NewInterceptor()
if err != nil { return ... }

handler := connect.NewHandler(path, svc,
    connect.WithInterceptors(otelInterceptor, authInterceptor, auditInterceptor),
)
```

This requires promoting `connectrpc.com/otelconnect` from indirect to a direct dependency:
```bash
go get connectrpc.com/otelconnect@latest
```

**This single change fixes distributed tracing across the API boundary** — every RPC call now:
- Extracts W3C trace context from the incoming request
- Creates a server span
- Injects trace context into the response
- Propagates context to downstream controller calls

### Task 1.2: Add `otelhttp` middleware to HTTP handlers

**Files:** Modify `cmd/main.go`, `cmd/main_operator.go`

Wrap the HTTP mux with `otelhttp.NewHandler`:

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

// Where the mux is built:
mux := http.NewServeMux()
// ... register routes ...
// Wrap:
handler := otelhttp.NewHandler(mux, "paprika-http")
```

This instruments SSE endpoints, webhook receiver, health probes, and /metrics with HTTP server spans.

### Task 1.3: Add `otelhttp` transport to outbound HTTP clients

**Files:** Modify `internal/health/cel.go` (HTTP probes), `internal/controller/pipelines/notification_controller.go` (webhook notifications)

Replace bare `http.Client{}` with:
```go
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
```

### Steps:
- [ ] Step 1: `go get connectrpc.com/otelconnect@latest` + `go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@latest`
- [ ] Step 2: Add otelconnect interceptor to all 3 cmd entry points.
- [ ] Step 3: Add otelhttp middleware to HTTP muxes.
- [ ] Step 4: Add otelhttp transport to outbound HTTP clients.
- [ ] Step 5: Verify build + tests + lint.
- [ ] Step 6: Commit: `feat(otel): auto-instrumentation — otelconnect interceptor, otelhttp middleware/transport`

---

## Chunk 2: Controller reconcile spans

### Task 2.1: Reusable `ReconcileSpan` helper + wire all reconcilers

**Files:** Create `internal/observability/reconcile.go`, modify all controller files.

Create a helper:
```go
// ReconcileSpan starts a top-level reconcile span. Defer the returned function
// to end the span and record errors.
func ReconcileSpan(ctx context.Context, controller string, req ctrl.Request) (context.Context, func(error)) {
	tracer := otel.Tracer("paprika/controller")
	ctx, span := tracer.Start(ctx, controller+".Reconcile",
		trace.WithAttributes(
			attribute.String("controller", controller),
			attribute.String("namespace", req.Namespace),
			attribute.String("name", req.Name),
		),
	)
	return ctx, func(err error) {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}
}
```

In each reconciler's `Reconcile` method, wrap the body:
```go
func (r *XxxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "Xxx", req)
	defer endSpan(nil) // will be overridden on error
	// ... existing body ...
	if err != nil {
		endSpan(err)
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}
```

Wire into ALL reconcilers (the 13 that are currently missing spans):
- `PipelineReconciler`, `StageReconciler`, `RolloutReconciler`, `TemplateReconciler`, `ApplicationSetReconciler`, `ArtifactReconciler`, `AnalysisRunReconciler`, `ConftestPolicyReconciler`, `NotificationConfigReconciler`, `ClusterReconciler`, `AppProjectReconciler`, `RepositoryReconciler`, `PolicyReconciler`, `FeatureFlagReconciler`, `FeatureFlagBindingReconciler`.

The existing 2 (`ReleaseReconciler`, `ApplicationReconciler`) should be migrated to use the new helper for consistency (removing the `//nolint:staticcheck` noop fallback path).

### Steps:
- [ ] Step 1: Write `reconcile.go` with `ReconcileSpan`.
- [ ] Step 2: Wire into all 13 uninstrumented reconcilers.
- [ ] Step 3: Migrate the 2 existing instrumented reconcilers to the new helper.
- [ ] Step 4: Verify build + tests + lint.
- [ ] Step 5: Commit: `feat(otel): reconcile spans on all controllers`

---

## Chunk 3: OTLP metrics dual-export + wire MetricsMiddleware

### Task 3.1: OTLP metrics exporter alongside Prometheus

**Files:** Modify `internal/observability/observability.go`, `cmd/main.go`

Add a `MeterProvider` to the `Telemetry` struct. When `OTLPEndpoint` is set, create an OTLP metric exporter (matching the trace protocol — grpc or http) and register it alongside the existing Prometheus registry.

Use `go.opentelemetry.io/otel/exporters/prometheus` (already the bridge between Prometheus collectors and OTel) — the existing 17 collectors registered on the Prometheus registry are automatically available via the OTel SDK's Meter.

For OTLP export, add `otlpmetricgrpc` or `otlpmetrichttp`:
```go
metricExporter, err := otlpmetricgrpc.New(ctx, /* same opts as trace */)
meterProvider := metric.NewMeterProvider(
    metric.WithReader(metric.NewPeriodicReader(metricExporter)),
    metric.WithResource(res),
)
otel.SetMeterProvider(meterProvider)
```

The periodic reader exports every 60s by default (configurable).

### Task 3.2: Wire the dead-code `MetricsMiddleware`

**Files:** Modify `cmd/main.go` (or wherever the API mux is built)

The `MetricsMiddleware` at `internal/api/metrics_handler.go:24-36` wraps an HTTP handler with Prometheus timing. It's defined but never used. Wire it into the API mux so `paprika_api_request_duration_seconds` and `paprika_api_request_total` actually fire.

### Steps:
- [ ] Step 1: Add OTLP metric exporter config to `observability.go` (parallel to trace exporter).
- [ ] Step 2: Add `MeterProvider` to `Telemetry` + shutdown.
- [ ] Step 3: Wire `MetricsMiddleware` into the API mux.
- [ ] Step 4: Verify build + tests + lint.
- [ ] Step 5: Commit: `feat(otel): OTLP metrics dual-export + wire API request metrics middleware`

---

## Chunk 4: Log/trace correlation (otelzap bridge)

### Task 4.1: otelzap bridge for trace-ID in logs

**Files:** Modify `internal/observability/observability.go`, `cmd/main.go`

Add `go.opentelemetry.io/contrib/bridges/otelzap` to go.mod.

Replace the zap core with an otelzap-bridged core:
```go
import otelzap "go.opentelemetry.io/contrib/bridges/otelzap"

// In logger setup:
zapCore := zapcore.NewCore(...)
bridgedCore := otelzap.NewCore("paprika", otelzap.WithLoggerProvider(logProvider))
combinedCore := zapcore.NewTee(zapCore, bridgedCore)
logger := zap.New(combinedCore)
```

This means every log line emitted while a span is active will include `trace_id` and `span_id` as structured fields — automatically, with no changes to call sites.

### Task 4.2: Audit logger trace-ID

**Files:** Modify `internal/audit/audit.go`

The `Record` method currently discards `ctx`. Replace with:
```go
func (l *LogAuditor) Record(ctx context.Context, event AuditEvent) {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        event.TraceID = span.SpanContext().TraceID().String()
        event.SpanID = span.SpanContext().SpanID().String()
    }
    // ... existing JSON marshal + stdout ...
}
```

Add `TraceID` and `SpanID` fields to the `AuditEvent` struct.

### Steps:
- [ ] Step 1: `go get go.opentelemetry.io/contrib/bridges/otelzap@latest`
- [ ] Step 2: Wire otelzap bridge in logger setup.
- [ ] Step 3: Add trace-ID to audit events.
- [ ] Step 4: Verify build + tests + lint.
- [ ] Step 5: Commit: `feat(otel): otelzap log bridge for trace-ID correlation + audit trace enrichment`

---

## Chunk 5: Helm chart wiring + Grafana fix

### Task 5.1: OTel values block + env vars in all deployments

**Files:** Modify `charts/chart/values.yaml`, all deployment templates

Add to `values.yaml`:
```yaml
otel:
  enabled: false
  endpoint: ""                    # e.g. "otel-collector.observability.svc:4317"
  protocol: "grpc"                # grpc or http
  insecure: true
  sampler: "always_on"
  samplerArg: ""
  headers: {}
  propagators: "tracecontext,baggage"
  resourceAttributes: {}
```

In each deployment template (manager, api-server, repo-server, webhook-receiver, agent), conditionally add env vars:
```yaml
{{- if .Values.otel.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otel.endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: {{ .Values.otel.protocol | quote }}
- name: OTEL_EXPORTER_OTLP_INSECURE
  value: {{ .Values.otel.insecure | quote }}
- name: OTEL_TRACES_SAMPLER
  value: {{ .Values.otel.sampler | quote }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .Values.otel.samplerArg | quote }}
- name: OTEL_PROPAGATORS
  value: {{ .Values.otel.propagators | quote }}
{{- end }}
```

Also set `PAPRIKA_NAMESPACE` and `PAPRIKA_POD_NAME` from the downward API for k8s resource attributes:
```yaml
- name: PAPRIKA_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: PAPRIKA_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
```

### Task 5.2: ServiceMonitors for split-plane components

**Files:** Create or modify `charts/chart/templates/prometheus/`

Add ServiceMonitor templates for api-server, repo-server, webhook-receiver (gated by `deploymentMode: split` + `prometheus.enable`). Model on the existing `controller-manager-metrics-monitor.yaml`.

### Task 5.3: Fix Grafana dashboard ConfigMap

**Files:** Modify `charts/chart/templates/grafana/dashboards.yaml`

The current template does `.Files.Get "grafana/overview.json"` but the file doesn't exist inside the chart. Fix by either:
- Copying `grafana/overview.json` into `charts/chart/grafana/` (so `.Files.Get` works).
- Or inlining the dashboard JSON directly in the template via `{{ .Files.Get "../../grafana/overview.json" }}` (won't work — Helm only reads within the chart dir).

Best approach: copy `grafana/overview.json` into `charts/chart/files/overview.json` and reference it via `.Files.Get "files/overview.json"`.

### Steps:
- [ ] Step 1: Add `otel:` block to values.yaml.
- [ ] Step 2: Conditionally add OTEL_* env vars to all deployment templates.
- [ ] Step 3: Add downward API env vars (PAPRIKA_NAMESPACE, PAPRIKA_POD_NAME).
- [ ] Step 4: Add ServiceMonitors for split-plane components.
- [ ] Step 5: Fix Grafana dashboard ConfigMap (copy file into chart).
- [ ] Step 6: `helm lint ./charts/chart` + `helm template` with otel enabled.
- [ ] Step 7: Commit: `feat(otel): Helm chart wiring — env vars, ServiceMonitors, Grafana fix`

---

## Verification

```bash
make manifests
bin/golangci-lint run
go test -count=1 ./internal/observability/... ./internal/controller/... ./internal/api/... ./internal/audit/...
helm lint ./charts/chart
helm template ./charts/chart --set otel.enabled=true --set otel.endpoint=test:4317 | grep OTEL_EXPORTER
```

All must pass.
