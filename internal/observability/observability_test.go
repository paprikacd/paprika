package observability

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"

	"github.com/benebsworth/paprika/internal/clock"
)

func TestNewTelemetry_Disabled(t *testing.T) {
	t.Parallel()
	telemetry, err := NewTelemetry(context.Background(), TelemetryConfig{})
	require.NoError(t, err)
	defer func() {
		require.NoError(t, telemetry.Shutdown(context.Background()))
	}()
	assert.False(t, telemetry.IsTracingEnabled())
}

func TestStartSpan_Disabled(t *testing.T) {
	t.Parallel()
	telemetry, err := NewTelemetry(context.Background(), TelemetryConfig{})
	require.NoError(t, err)

	ctx, span := telemetry.StartSpan(context.Background(), "test")
	assert.NotNil(t, ctx)
	assert.NotNil(t, span)
	span.End()
}

func TestStartSpan_WithAttributes(t *testing.T) {
	t.Parallel()
	telemetry, err := NewTelemetry(context.Background(), TelemetryConfig{})
	require.NoError(t, err)

	ctx, span := telemetry.StartSpan(context.Background(), "test", attribute.String("key", "value"))
	assert.NotNil(t, ctx)
	assert.NotNil(t, span)
	span.End()
}

func TestSpanFromContext(t *testing.T) {
	t.Parallel()
	telemetry := &Telemetry{}
	ctx := context.Background()
	span := telemetry.SpanFromContext(ctx)
	assert.NotNil(t, span)
}

func TestCorrelationID(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	assert.Equal(t, "", CorrelationID(ctx))

	ctx = WithCorrelationID(ctx, "abc-123")
	assert.Equal(t, "abc-123", CorrelationID(ctx))
}

func TestAuditLogger(t *testing.T) {
	t.Parallel()
	logger := NewAuditLogger(true, &clock.Fake{})
	assert.True(t, logger.enabled)

	// Should not panic
	logger.Log("CREATE", "Application", "default", "my-app", "admin", map[string]string{"version": "1.0"})
}

func TestAuditLogger_Disabled(t *testing.T) {
	t.Parallel()
	logger := NewAuditLogger(false, &clock.Fake{})
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
