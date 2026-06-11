package observability

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
)

func TestInitTracing_Disabled(t *testing.T) {
	t.Setenv(otelEndpointEnv, "")
	shutdown, err := InitTracing()
	require.NoError(t, err)
	defer shutdown()
	assert.False(t, IsTracingEnabled())
}

func TestStartSpan_Disabled(t *testing.T) {
	t.Setenv(otelEndpointEnv, "")
	_, err := InitTracing()
	require.NoError(t, err)

	ctx, span := StartSpan(context.Background(), "test")
	assert.NotNil(t, ctx)
	assert.NotNil(t, span)
	span.End()
}

func TestStartSpan_WithAttributes(t *testing.T) {
	t.Setenv(otelEndpointEnv, "")
	_, err := InitTracing()
	require.NoError(t, err)

	ctx, span := StartSpan(context.Background(), "test", attribute.String("key", "value"))
	assert.NotNil(t, ctx)
	assert.NotNil(t, span)
	span.End()
}

func TestSpanFromContext(t *testing.T) {
	ctx := context.Background()
	span := SpanFromContext(ctx)
	assert.NotNil(t, span)
}

func TestCorrelationID(t *testing.T) {
	ctx := context.Background()
	assert.Equal(t, "", CorrelationID(ctx))

	ctx = WithCorrelationID(ctx, "abc-123")
	assert.Equal(t, "abc-123", CorrelationID(ctx))
}

func TestAuditLogger(t *testing.T) {
	t.Setenv("PAPRIKA_AUDIT_LOG", "true")
	logger := NewAuditLogger()
	assert.True(t, logger.enabled)

	// Should not panic
	logger.Log("CREATE", "Application", "default", "my-app", "admin", map[string]string{"version": "1.0"})
}

func TestAuditLogger_Disabled(t *testing.T) {
	t.Setenv("PAPRIKA_AUDIT_LOG", "false")
	logger := NewAuditLogger()
	assert.False(t, logger.enabled)

	// Should not panic or print
	logger.Log("CREATE", "Application", "default", "my-app", "admin", nil)
}

func TestVersion(t *testing.T) {
	t.Setenv("PAPRIKA_VERSION", "1.2.3")
	assert.Equal(t, "1.2.3", version())

	t.Setenv("PAPRIKA_VERSION", "")
	assert.Equal(t, "dev", version())
}
