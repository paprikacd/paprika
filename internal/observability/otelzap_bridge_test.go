package observability

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	otelzap "go.opentelemetry.io/contrib/bridges/otelzap"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	gozap "go.uber.org/zap"
	gozapcore "go.uber.org/zap/zapcore"
)

// memoryLogExporter captures exported log records for assertions. It implements
// sdklog.Exporter. Used with a SimpleProcessor so export is synchronous and
// records are observable immediately after a log call.
type memoryLogExporter struct {
	records []sdklog.Record
}

func (m *memoryLogExporter) Export(_ context.Context, records []sdklog.Record) error {
	for i := range records {
		m.records = append(m.records, records[i].Clone())
	}
	return nil
}

func (m *memoryLogExporter) ForceFlush(context.Context) error { return nil }
func (m *memoryLogExporter) Shutdown(context.Context) error   { return nil }

// TestOTelZapBridgeForwardsRecordsWithTraceCorrelation proves the otelzap core,
// teed onto a zap logger, forwards each log record to the OTel Logs signal and
// carries the active span's TraceID/SpanID when the context is supplied as a zap
// field (the documented otelzap contract). This is the mechanism the production
// logger bridge in cmd/ relies on.
func TestOTelZapBridgeForwardsRecordsWithTraceCorrelation(t *testing.T) {
	// Real tracer so the span context is sampled/valid.
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracer := tp.Tracer("test")

	// In-memory log signal backed by a synchronous processor.
	mem := &memoryLogExporter{}
	lp := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewSimpleProcessor(mem)))
	t.Cleanup(func() { _ = lp.Shutdown(context.Background()) })

	// Bridged zap logger: a discarded stdout core teed with the otelzap core.
	otelCore := otelzap.NewCore("paprika", otelzap.WithLoggerProvider(lp))
	logger := gozap.New(gozapcore.NewTee(
		gozapcore.NewCore(
			gozapcore.NewJSONEncoder(gozap.NewProductionEncoderConfig()),
			gozapcore.AddSync(discardWriter{}),
			gozapcore.InfoLevel,
		),
		otelCore,
	))

	ctx, span := tracer.Start(context.Background(), "reconcile")
	defer span.End()
	wantTrace := span.SpanContext().TraceID().String()
	wantSpan := span.SpanContext().SpanID().String()
	require.NotEmpty(t, wantTrace, "span must be sampled for a valid TraceID")

	// otelzap reads the active span from a context.Context-typed zap field.
	logger.Info("reconciling resource", gozap.Any("context", ctx))

	require.Len(t, mem.records, 1, "exactly one log record should be forwarded")
	rec := mem.records[0]
	assert.Equal(t, "reconciling resource", rec.Body().AsString(), "record body is the log message")
	assert.Equal(t, wantTrace, rec.TraceID().String(), "forwarded record carries the span TraceID")
	assert.Equal(t, wantSpan, rec.SpanID().String(), "forwarded record carries the span SpanID")
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

// TestLoggerProviderNilWhenDisabled guards the cmd/ bridge wiring: when tracing
// is disabled (no OTLP endpoint), NewTelemetry returns a Telemetry whose
// LoggerProvider() is nil, so the bridge helper skips bridging entirely.
func TestLoggerProviderNilWhenDisabled(t *testing.T) {
	tel := NewTelemetry(context.Background(), Config{})
	t.Cleanup(func() { require.NoError(t, tel.Shutdown(context.Background())) })
	assert.Nil(t, tel.LoggerProvider(), "LoggerProvider must be nil when no OTLP endpoint is configured")
	assert.False(t, tel.IsTracingEnabled())
}
