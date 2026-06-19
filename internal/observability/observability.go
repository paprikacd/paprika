// Package observability provides tracing, audit logging, and event recording.
package observability

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/benebsworth/paprika/internal/clock"
)

const tracerName = "github.com/benebsworth/paprika"

// TelemetryConfig holds externally-provided OpenTelemetry settings.
type TelemetryConfig struct {
	OTLPEndpoint   string
	ServiceName    string
	ServiceVersion string
}

// Telemetry holds OpenTelemetry state for the process. It replaces the
// package-level mutable globals used by earlier versions of this package.
type Telemetry struct {
	tracer   trace.Tracer
	provider *sdktrace.TracerProvider
	enabled  bool
}

// StartSpan starts a new OpenTelemetry span from context.
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

// Shutdown gracefully shuts down the tracer provider.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if t == nil || t.provider == nil {
		return nil
	}
	if err := t.provider.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown tracer provider: %w", err)
	}
	return nil
}

// noopTelemetry is the default telemetry instance used by the deprecated
// package-level helpers. It is immutable and safe for concurrent use.
var noopTelemetry = &Telemetry{}

// NewTelemetry initializes OpenTelemetry tracing from explicit configuration.
func NewTelemetry(ctx context.Context, cfg TelemetryConfig) (*Telemetry, error) {
	if cfg.OTLPEndpoint == "" {
		return &Telemetry{}, nil
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = "paprika"
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	client := otlptracegrpc.NewClient(
		otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint),
		otlptracegrpc.WithInsecure(),
	)
	exporter, err := otlptrace.New(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(cfg.ServiceName),
			semconv.ServiceVersionKey.String(cfg.ServiceVersion),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("create trace resource: %w", err)
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)

	otel.SetTracerProvider(provider)

	return &Telemetry{
		provider: provider,
		tracer:   provider.Tracer(tracerName),
		enabled:  true,
	}, nil
}

// InitTracing initializes OpenTelemetry tracing with OTLP gRPC exporter from
// environment variables.
//
// Deprecated: read OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME and
// PAPRIKA_VERSION in cmd/main and pass a TelemetryConfig to NewTelemetry.
func InitTracing(ctx context.Context) (*Telemetry, error) {
	return NewTelemetry(ctx, TelemetryConfig{
		OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		ServiceName:    os.Getenv("OTEL_SERVICE_NAME"),
		ServiceVersion: version(),
	})
}

// InitTracingLegacy initializes tracing using a background context.
//
// Deprecated: use InitTracing(ctx) and the returned *Telemetry instead.
func InitTracingLegacy() (func(), error) {
	telemetry, err := InitTracing(context.Background())
	if err != nil {
		return nil, err
	}
	return func() {
		if shutdownErr := telemetry.Shutdown(context.Background()); shutdownErr != nil {
			log.Printf("Failed to shutdown tracing: %v", shutdownErr)
		}
	}, nil
}

// StartSpan starts a new OpenTelemetry span from context.
//
// Deprecated: use Telemetry.StartSpan on an instance returned by InitTracing.
func StartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return noopTelemetry.StartSpan(ctx, name, attrs...)
}

// SpanFromContext returns the current span from context.
//
// Deprecated: use Telemetry.SpanFromContext.
func SpanFromContext(ctx context.Context) trace.Span {
	return noopTelemetry.SpanFromContext(ctx)
}

// IsTracingEnabled returns whether tracing is active.
//
// Deprecated: use Telemetry.IsTracingEnabled.
func IsTracingEnabled() bool {
	return noopTelemetry.IsTracingEnabled()
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

func version() string {
	if v := os.Getenv("PAPRIKA_VERSION"); v != "" {
		return v
	}
	return "dev"
}
