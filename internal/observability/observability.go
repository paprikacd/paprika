// Package observability provides tracing, audit logging, and event recording.
package observability

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/benebsworth/paprika/internal/clock"
)

const tracerName = "github.com/benebsworth/paprika"

// Config holds all OpenTelemetry SDK configuration, populated from standard
// OTEL_* environment variables.
type Config struct {
	OTLPEndpoint    string
	Protocol        string // "grpc" (default) or "http"
	Insecure        bool
	CertificatePath string
	Headers         map[string]string
	Sampler         string
	SamplerArg      string
	Propagators     string
	ServiceName     string
	ServiceVersion  string
	BatchTimeout    time.Duration
	MaxQueueSize    int
	ResourceAttrs   map[string]string
}

// ConfigFromEnv reads the standard OTEL_* environment variables and returns a
// fully populated Config with specification-compliant defaults.
func ConfigFromEnv() Config {
	return Config{
		OTLPEndpoint:    os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		Protocol:        envOrDefault("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"),
		Insecure:        envBoolOrDefault("OTEL_EXPORTER_OTLP_INSECURE", true),
		CertificatePath: os.Getenv("OTEL_EXPORTER_OTLP_CERTIFICATE"),
		Sampler:         envOrDefault("OTEL_TRACES_SAMPLER", "always_on"),
		SamplerArg:      os.Getenv("OTEL_TRACES_SAMPLER_ARG"),
		Propagators:     envOrDefault("OTEL_PROPAGATORS", "tracecontext,baggage"),
		ServiceName:     envOrDefault("OTEL_SERVICE_NAME", "paprika"),
		ServiceVersion:  envOrDefault("PAPRIKA_VERSION", "dev"),
		BatchTimeout:    5 * time.Second,
		MaxQueueSize:    2048,
		Headers:         parseHeaders(os.Getenv("OTEL_EXPORTER_OTLP_HEADERS")),
		ResourceAttrs:   parseResourceAttrs(os.Getenv("OTEL_RESOURCE_ATTRIBUTES")),
	}
}

// Telemetry holds OpenTelemetry state for the process.
type Telemetry struct {
	tracer         trace.Tracer
	provider       *sdktrace.TracerProvider
	meterProvider  *metric.MeterProvider
	loggerProvider *sdklog.LoggerProvider
	enabled        bool
}

// StartSpan starts a new OpenTelemetry span from context. When tracing is
// disabled it returns a no-op span derived from the context.
func (t *Telemetry) StartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	if t == nil || !t.enabled || t.tracer == nil {
		return ctx, trace.SpanFromContext(ctx)
	}
	return t.tracer.Start(ctx, name, trace.WithAttributes(attrs...))
}

// SpanFromContext returns the current span from context.
func (t *Telemetry) SpanFromContext(ctx context.Context) trace.Span {
	return trace.SpanFromContext(ctx)
}

// IsTracingEnabled returns whether tracing is active.
func (t *Telemetry) IsTracingEnabled() bool {
	return t != nil && t.enabled
}

// LoggerProvider returns the OpenTelemetry LoggerProvider backing the zap log
// bridge (otelzap). It returns nil when tracing is disabled so callers can skip
// log bridging without an extra flag check.
func (t *Telemetry) LoggerProvider() otellog.LoggerProvider {
	if t == nil {
		return nil
	}
	return t.loggerProvider
}

// Shutdown gracefully shuts down the tracer, meter, and logger providers,
// flushing any buffered spans, metrics, and logs to their exporters.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if t == nil {
		return nil
	}
	var errs []error
	if t.loggerProvider != nil {
		if err := t.loggerProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("shutdown logger provider: %w", err))
		}
	}
	if t.meterProvider != nil {
		if err := t.meterProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("shutdown meter provider: %w", err))
		}
	}
	if t.provider != nil {
		if err := t.provider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("shutdown tracer provider: %w", err))
		}
	}
	return errors.Join(errs...)
}

// NewTelemetry creates and registers a fully configured OpenTelemetry
// Telemetry instance from cfg. ctx bounds exporter setup and is not retained.
// It returns a disabled Telemetry (rather than an error) when the OTLP endpoint
// is empty or the exporter cannot be built, so callers always get a usable value.
//
//nolint:gocritic // cfg is a one-time startup config; copying is negligible.
func NewTelemetry(ctx context.Context, cfg Config) *Telemetry {
	if cfg.OTLPEndpoint == "" {
		return &Telemetry{}
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	res := buildResource(ctx, &cfg)

	exporter, err := buildTraceExporter(ctx, &cfg)
	if err != nil {
		log.Printf("otel: failed to create trace exporter, tracing disabled: %v", err)
		return &Telemetry{}
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(buildSampler(&cfg)),
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(exporter,
			sdktrace.WithBatchTimeout(cfg.BatchTimeout),
			sdktrace.WithMaxQueueSize(cfg.MaxQueueSize),
		),
	)

	otel.SetTracerProvider(provider)
	setPropagator(cfg.Propagators)

	t := &Telemetry{
		provider: provider,
		tracer:   provider.Tracer(tracerName),
		enabled:  true,
	}

	metricExporter, err := buildMetricExporter(ctx, &cfg)
	if err != nil {
		log.Printf("otel: failed to create metric exporter, metrics disabled: %v", err)
		return t
	}
	meterProvider := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter, metric.WithInterval(60*time.Second))),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(meterProvider)
	t.meterProvider = meterProvider

	// Logs signal: build a LoggerProvider so the otelzap bridge can forward zap
	// records to the same OTLP backend as traces and metrics. A failure here
	// leaves logs unbridged (stdout JSON is unaffected) so it is non-fatal.
	logExporter, err := buildLogExporter(ctx, &cfg)
	if err != nil {
		log.Printf("otel: failed to create log exporter, log bridging disabled: %v", err)
		return t
	}
	loggerProvider := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter,
			sdklog.WithMaxQueueSize(cfg.MaxQueueSize),
			sdklog.WithExportInterval(cfg.BatchTimeout),
		)),
	)
	global.SetLoggerProvider(loggerProvider)
	t.loggerProvider = loggerProvider
	return t
}

// buildResource creates an OTel Resource with service identity, host/process
// detectors, Kubernetes attributes (from env), and user-provided attributes.
func buildResource(ctx context.Context, cfg *Config) *resource.Resource {
	opts := []resource.Option{
		resource.WithSchemaURL(semconv.SchemaURL),
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
		),
		resource.WithHost(),
		resource.WithProcess(),
	}

	// Kubernetes attributes surfaced via the downward API or Helm.
	var k8sAttrs []attribute.KeyValue
	if ns := os.Getenv("PAPRIKA_NAMESPACE"); ns != "" {
		k8sAttrs = append(k8sAttrs, semconv.K8SNamespaceName(ns))
	}
	if pod := os.Getenv("PAPRIKA_POD_NAME"); pod != "" {
		k8sAttrs = append(k8sAttrs, semconv.K8SPodName(pod))
	}
	if len(k8sAttrs) > 0 {
		opts = append(opts, resource.WithAttributes(k8sAttrs...))
	}

	// User-provided resource attributes from OTEL_RESOURCE_ATTRIBUTES.
	for k, v := range cfg.ResourceAttrs {
		opts = append(opts, resource.WithAttributes(attribute.String(k, v)))
	}

	res, err := resource.New(ctx, opts...)
	if err != nil {
		log.Printf("otel: failed to build resource, using partial: %v", err)
	}
	return res
}

// buildTraceExporter creates an OTLP trace exporter for the configured protocol.
func buildTraceExporter(ctx context.Context, cfg *Config) (*otlptrace.Exporter, error) {
	if cfg.Protocol == "http" {
		var httpOpts []otlptracehttp.Option
		httpOpts = append(httpOpts, otlptracehttp.WithEndpoint(cfg.OTLPEndpoint))
		if cfg.Insecure {
			httpOpts = append(httpOpts, otlptracehttp.WithInsecure())
		}
		if len(cfg.Headers) > 0 {
			httpOpts = append(httpOpts, otlptracehttp.WithHeaders(cfg.Headers))
		}
		exp, err := otlptrace.New(ctx, otlptracehttp.NewClient(httpOpts...))
		if err != nil {
			return nil, fmt.Errorf("create otlp http trace exporter: %w", err)
		}
		return exp, nil
	}

	// Default: gRPC.
	var opts []otlptracegrpc.Option
	opts = append(opts, otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint))
	switch {
	case cfg.Insecure:
		opts = append(opts, otlptracegrpc.WithDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())))
	case cfg.CertificatePath != "":
		creds, err := credentials.NewClientTLSFromFile(cfg.CertificatePath, "")
		if err != nil {
			return nil, fmt.Errorf("load TLS cert: %w", err)
		}
		opts = append(opts, otlptracegrpc.WithDialOption(grpc.WithTransportCredentials(creds)))
	}
	if len(cfg.Headers) > 0 {
		opts = append(opts, otlptracegrpc.WithHeaders(cfg.Headers))
	}
	exp, err := otlptrace.New(ctx, otlptracegrpc.NewClient(opts...))
	if err != nil {
		return nil, fmt.Errorf("create otlp grpc trace exporter: %w", err)
	}
	return exp, nil
}

// buildMetricExporter creates an OTLP metric exporter for the configured
// protocol. It mirrors buildTraceExporter: same endpoint, TLS, and headers.
//
//nolint:dupl // intentionally mirrors build{Trace,Log}Exporter; option types differ per signal.
func buildMetricExporter(ctx context.Context, cfg *Config) (metric.Exporter, error) {
	if cfg.Protocol == "http" {
		var httpOpts []otlpmetrichttp.Option
		httpOpts = append(httpOpts, otlpmetrichttp.WithEndpoint(cfg.OTLPEndpoint))
		if cfg.Insecure {
			httpOpts = append(httpOpts, otlpmetrichttp.WithInsecure())
		}
		if len(cfg.Headers) > 0 {
			httpOpts = append(httpOpts, otlpmetrichttp.WithHeaders(cfg.Headers))
		}
		exp, err := otlpmetrichttp.New(ctx, httpOpts...)
		if err != nil {
			return nil, fmt.Errorf("create otlp http metric exporter: %w", err)
		}
		return exp, nil
	}

	// Default: gRPC.
	var opts []otlpmetricgrpc.Option
	opts = append(opts, otlpmetricgrpc.WithEndpoint(cfg.OTLPEndpoint))
	switch {
	case cfg.Insecure:
		opts = append(opts, otlpmetricgrpc.WithDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())))
	case cfg.CertificatePath != "":
		creds, err := credentials.NewClientTLSFromFile(cfg.CertificatePath, "")
		if err != nil {
			return nil, fmt.Errorf("load TLS cert: %w", err)
		}
		opts = append(opts, otlpmetricgrpc.WithDialOption(grpc.WithTransportCredentials(creds)))
	}
	if len(cfg.Headers) > 0 {
		opts = append(opts, otlpmetricgrpc.WithHeaders(cfg.Headers))
	}
	exp, err := otlpmetricgrpc.New(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("create otlp grpc metric exporter: %w", err)
	}
	return exp, nil
}

// buildLogExporter creates an OTLP log exporter for the configured protocol.
// It mirrors buildTraceExporter and buildMetricExporter so all three signals
// share one endpoint, TLS, and header configuration.
//
//nolint:dupl // intentionally mirrors build{Trace,Metric}Exporter; option types differ per signal.
func buildLogExporter(ctx context.Context, cfg *Config) (sdklog.Exporter, error) {
	if cfg.Protocol == "http" {
		var httpOpts []otlploghttp.Option
		httpOpts = append(httpOpts, otlploghttp.WithEndpoint(cfg.OTLPEndpoint))
		if cfg.Insecure {
			httpOpts = append(httpOpts, otlploghttp.WithInsecure())
		}
		if len(cfg.Headers) > 0 {
			httpOpts = append(httpOpts, otlploghttp.WithHeaders(cfg.Headers))
		}
		exp, err := otlploghttp.New(ctx, httpOpts...)
		if err != nil {
			return nil, fmt.Errorf("create otlp http log exporter: %w", err)
		}
		return exp, nil
	}

	// Default: gRPC.
	var opts []otlploggrpc.Option
	opts = append(opts, otlploggrpc.WithEndpoint(cfg.OTLPEndpoint))
	switch {
	case cfg.Insecure:
		opts = append(opts, otlploggrpc.WithDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())))
	case cfg.CertificatePath != "":
		creds, err := credentials.NewClientTLSFromFile(cfg.CertificatePath, "")
		if err != nil {
			return nil, fmt.Errorf("load TLS cert: %w", err)
		}
		opts = append(opts, otlploggrpc.WithDialOption(grpc.WithTransportCredentials(creds)))
	}
	if len(cfg.Headers) > 0 {
		opts = append(opts, otlploggrpc.WithHeaders(cfg.Headers))
	}
	exp, err := otlploggrpc.New(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("create otlp grpc log exporter: %w", err)
	}
	return exp, nil
}

// buildSampler maps the configured sampler name to an sdktrace.Sampler.
func buildSampler(cfg *Config) sdktrace.Sampler {
	ratio := 1.0
	if cfg.SamplerArg != "" {
		if r, err := strconv.ParseFloat(cfg.SamplerArg, 64); err == nil {
			ratio = r
		}
	}
	switch cfg.Sampler {
	case "always_off":
		return sdktrace.NeverSample()
	case "traceidratio":
		return sdktrace.TraceIDRatioBased(ratio)
	case "parentbased_always_on":
		return sdktrace.ParentBased(sdktrace.AlwaysSample())
	case "parentbased_traceidratio":
		return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio))
	default: // "always_on"
		return sdktrace.AlwaysSample()
	}
}

// setPropagator configures the global composite text map propagator.
func setPropagator(propagators string) {
	var props []propagation.TextMapPropagator
	for _, p := range strings.Split(propagators, ",") {
		switch strings.TrimSpace(p) {
		case "tracecontext":
			props = append(props, propagation.TraceContext{})
		case "baggage":
			props = append(props, propagation.Baggage{})
		}
	}
	if len(props) > 0 {
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(props...))
	}
}

// parseHeaders parses a "key1=val1,key2=val2" list into a map. Malformed
// entries are skipped. Returns nil for an empty input.
func parseHeaders(s string) map[string]string {
	if s == "" {
		return nil
	}
	out := make(map[string]string)
	for _, pair := range strings.Split(s, ",") {
		kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.TrimSpace(kv[0])
		v := strings.TrimSpace(kv[1])
		if k == "" {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseResourceAttrs parses OTEL_RESOURCE_ATTRIBUTES using the same format as
// parseHeaders.
func parseResourceAttrs(s string) map[string]string {
	return parseHeaders(s)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBoolOrDefault(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// EventRecorder records Kubernetes events for resources.
type EventRecorder struct {
	recorder record.EventRecorder
}

// NewEventRecorder creates an event recorder from a controller-runtime manager.
func NewEventRecorder(rec record.EventRecorder) *EventRecorder {
	return &EventRecorder{recorder: rec}
}

// Normal records a normal (informational) event.
func (e *EventRecorder) Normal(obj runtime.Object, reason, message string) {
	if e.recorder == nil {
		return
	}
	e.recorder.Eventf(obj, corev1.EventTypeNormal, reason, message)
}

// Warning records a warning event.
func (e *EventRecorder) Warning(obj runtime.Object, reason, message string) {
	if e.recorder == nil {
		return
	}
	e.recorder.Eventf(obj, corev1.EventTypeWarning, reason, message)
}

// AuditLogger records audit events to stdout.
type AuditLogger struct {
	enabled bool
	clock   clock.Clock
}

// NewAuditLogger creates an audit logger.
func NewAuditLogger(enabled bool, clk clock.Clock) *AuditLogger {
	if clk == nil {
		clk = clock.Real{}
	}
	return &AuditLogger{enabled: enabled, clock: clk}
}

// Log records an audit event.
func (a *AuditLogger) Log(action, resource, namespace, name, user string, details map[string]string) {
	if !a.enabled {
		return
	}

	// Simple stdout audit log; in production, send to a structured log aggregator.
	var b strings.Builder
	for k, v := range details {
		fmt.Fprintf(&b, " %s=%q", k, v)
	}
	fmt.Printf(`{"ts":"%s","action":"%s","resource":"%s","namespace":"%s","name":"%s","user":"%s"%s}`+"\n",
		a.clock.Now().UTC().Format(time.RFC3339Nano),
		action, resource, namespace, name, user, b.String(),
	)
}

// CorrelationIDKey is the context key for correlation IDs.
type CorrelationIDKey struct{}

// WithCorrelationID adds a correlation ID to context.
func WithCorrelationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, CorrelationIDKey{}, id)
}

// CorrelationID extracts the correlation ID from context.
func CorrelationID(ctx context.Context) string {
	if id, ok := ctx.Value(CorrelationIDKey{}).(string); ok {
		return id
	}
	return ""
}
