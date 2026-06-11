// Package observability provides tracing, audit logging, and event recording.
package observability

import (
	"context"
	"fmt"
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
)

const (
	tracerName      = "github.com/benebsworth/paprika"
	otelEndpointEnv = "OTEL_EXPORTER_OTLP_ENDPOINT"
	otelServiceEnv  = "OTEL_SERVICE_NAME"
)

var (
	tracer   trace.Tracer
	provider *sdktrace.TracerProvider
	enabled  bool
)

// InitTracing initializes OpenTelemetry tracing with OTLP gRPC exporter.
func InitTracing() (func(), error) {
	endpoint := os.Getenv(otelEndpointEnv)
	if endpoint == "" {
		return func() {}, nil
	}

	serviceName := os.Getenv(otelServiceEnv)
	if serviceName == "" {
		serviceName = "paprika"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := otlptracegrpc.NewClient(
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	exporter, err := otlptrace.New(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(serviceName),
			semconv.ServiceVersionKey.String(version()),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("create trace resource: %w", err)
	}

	provider = sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)

	otel.SetTracerProvider(provider)
	tracer = provider.Tracer(tracerName)
	enabled = true

	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = provider.Shutdown(ctx)
	}
	return shutdown, nil
}

// StartSpan starts a new OpenTelemetry span from context.
func StartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	if !enabled || tracer == nil {
		return ctx, trace.SpanFromContext(ctx)
	}
	return tracer.Start(ctx, name, trace.WithAttributes(attrs...))
}

// SpanFromContext returns the current span from context.
func SpanFromContext(ctx context.Context) trace.Span {
	return trace.SpanFromContext(ctx)
}

// IsTracingEnabled returns whether tracing is active.
func IsTracingEnabled() bool {
	return enabled
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
}

// NewAuditLogger creates an audit logger.
func NewAuditLogger() *AuditLogger {
	return &AuditLogger{enabled: os.Getenv("PAPRIKA_AUDIT_LOG") == "true"}
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
		time.Now().UTC().Format(time.RFC3339Nano),
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
