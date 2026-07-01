package observability

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigFromEnv_Defaults(t *testing.T) {
	os.Unsetenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	os.Unsetenv("OTEL_EXPORTER_OTLP_PROTOCOL")
	os.Unsetenv("OTEL_EXPORTER_OTLP_INSECURE")
	os.Unsetenv("OTEL_TRACES_SAMPLER")
	os.Unsetenv("OTEL_SERVICE_NAME")

	cfg := ConfigFromEnv()

	assert.Equal(t, "grpc", cfg.Protocol, "default protocol is grpc")
	assert.True(t, cfg.Insecure, "default insecure is true")
	assert.Equal(t, "always_on", cfg.Sampler, "default sampler is always_on")
	assert.Equal(t, "paprika", cfg.ServiceName, "default service name is paprika")
	assert.Equal(t, "tracecontext,baggage", cfg.Propagators)
	assert.Equal(t, 5*time.Second, cfg.BatchTimeout)
	assert.Equal(t, 2048, cfg.MaxQueueSize)
}

func TestConfigFromEnv_OTLPProtocol(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http")
	cfg := ConfigFromEnv()
	assert.Equal(t, "http", cfg.Protocol)
}

func TestConfigFromEnv_SamplerTraceIDRatio(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "traceidratio")
	t.Setenv("OTEL_TRACES_SAMPLER_ARG", "0.5")
	cfg := ConfigFromEnv()
	assert.Equal(t, "traceidratio", cfg.Sampler)
	assert.Equal(t, "0.5", cfg.SamplerArg)
}

func TestConfigFromEnv_ParentBased(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "parentbased_traceidratio")
	t.Setenv("OTEL_TRACES_SAMPLER_ARG", "0.1")
	cfg := ConfigFromEnv()
	assert.Equal(t, "parentbased_traceidratio", cfg.Sampler)
	assert.Equal(t, "0.1", cfg.SamplerArg)
}

func TestConfigFromEnv_TLSCertificate(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_INSECURE", "false")
	t.Setenv("OTEL_EXPORTER_OTLP_CERTIFICATE", "/etc/ssl/certs/ca.pem")
	cfg := ConfigFromEnv()
	assert.False(t, cfg.Insecure)
	assert.Equal(t, "/etc/ssl/certs/ca.pem", cfg.CertificatePath)
}

func TestConfigFromEnv_Headers(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "x-api-key=secret,tenant=acme")
	cfg := ConfigFromEnv()
	assert.Equal(t, "secret", cfg.Headers["x-api-key"])
	assert.Equal(t, "acme", cfg.Headers["tenant"])
}

func TestConfigFromEnv_ResourceAttributes(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=production,service.namespace=paprika-prod")
	cfg := ConfigFromEnv()
	assert.Equal(t, "production", cfg.ResourceAttrs["deployment.environment"])
	assert.Equal(t, "paprika-prod", cfg.ResourceAttrs["service.namespace"])
}

func TestConfigFromEnv_Propagators(t *testing.T) {
	t.Setenv("OTEL_PROPAGATORS", "tracecontext,baggage,b3")
	cfg := ConfigFromEnv()
	assert.Equal(t, "tracecontext,baggage,b3", cfg.Propagators)
}

func TestConfigFromEnv_Endpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector.observability.svc:4317")
	cfg := ConfigFromEnv()
	assert.Equal(t, "otel-collector.observability.svc:4317", cfg.OTLPEndpoint)
}

func TestNewTelemetry_Disabled(t *testing.T) {
	t.Parallel()
	telemetry := NewTelemetry(context.Background(), Config{})
	defer func() {
		require.NoError(t, telemetry.Shutdown(context.Background()))
	}()
	assert.False(t, telemetry.IsTracingEnabled())
}

func TestStartSpan_Disabled(t *testing.T) {
	t.Parallel()
	telemetry := NewTelemetry(context.Background(), Config{})

	ctx, span := telemetry.StartSpan(context.Background(), "test")
	assert.NotNil(t, ctx)
	assert.NotNil(t, span)
	span.End()
}

func TestCorrelationID(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	assert.Equal(t, "", CorrelationID(ctx))

	ctx = WithCorrelationID(ctx, "abc-123")
	assert.Equal(t, "abc-123", CorrelationID(ctx))
}

func TestParseHeaders(t *testing.T) {
	t.Parallel()
	assert.Nil(t, parseHeaders(""))
	m := parseHeaders("a=1, b=2,c=3")
	assert.Equal(t, "1", m["a"])
	assert.Equal(t, "2", m["b"])
	assert.Equal(t, "3", m["c"])
}

func TestParseHeaders_Malformed(t *testing.T) {
	t.Parallel()
	m := parseHeaders("a=1,nokey, = ,b=2")
	assert.Equal(t, "1", m["a"])
	assert.Equal(t, "2", m["b"])
	_, ok := m["nokey"]
	assert.False(t, ok)
}
