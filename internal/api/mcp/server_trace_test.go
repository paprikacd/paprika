package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func installMCPTestTracer(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	return exporter
}

func TestToolCallSpanParentsToolWorkAndRecordsBoundedOutcome(t *testing.T) {
	// Keep this test serial: it replaces the global tracer provider.
	exporter := installMCPTestTracer(t)

	tests := []struct {
		name       string
		invoke     func(context.Context) (any, error)
		wantStatus codes.Code
		wantResult string
	}{
		{
			name: "ok",
			invoke: func(context.Context) (any, error) {
				return &sdkmcp.CallToolResult{Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: "provider result"}}}, nil
			},
			wantStatus: codes.Unset,
			wantResult: "ok",
		},
		{
			name: "error",
			invoke: func(context.Context) (any, error) {
				return nil, errors.New("upstream rejected namespace secret-team")
			},
			wantStatus: codes.Error,
			wantResult: "error",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			exporter.Reset()
			var toolSpan trace.SpanContext
			r := NewRegistry()
			tool := stubTool("query_metrics", ScopeObserve, false)
			tool.Invoke = func(ctx context.Context, _ v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
				toolSpan = trace.SpanContextFromContext(ctx)
				return test.invoke(ctx)
			}
			require.NoError(t, r.Register(tool))
			srv := newObservabilityTestServer(t, r, nil)
			doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","arguments":{}}}`, observeBearerFor(t, ScopeObserve))

			spans := exporter.GetSpans()
			require.Len(t, spans, 1)
			span := spans[0]
			assert.Equal(t, "tools/call query_metrics", span.Name)
			assert.Equal(t, span.SpanContext.SpanID(), toolSpan.SpanID(),
				"the tool must run inside the call span so its own spans nest under it")

			attributes := map[string]string{}
			for _, attr := range span.Attributes {
				attributes[string(attr.Key)] = attr.Value.Emit()
			}
			assert.Equal(t, "tools/call", attributes["mcp.method.name"])
			assert.Equal(t, "query_metrics", attributes["gen_ai.tool.name"])
			assert.Equal(t, test.wantResult, attributes["outcome"])
			assert.Equal(t, test.wantStatus, span.Status.Code)

			for key, value := range attributes {
				assert.NotContains(t, value, "secret-team", "attribute %s must not carry error text", key)
			}
			assert.False(t, strings.Contains(span.Status.Description, "secret-team"),
				"span status must carry only the bounded outcome")
			assert.Empty(t, span.Events, "the span must not record the error as an exception event")
		})
	}
}
