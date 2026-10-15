package mcp

import (
	"context"
	"encoding/json"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

func TestToolErrorResultRecordsErrorOutcomeWithoutChangingWireResult(t *testing.T) {
	// Keep this test serial: it temporarily replaces package instruments.
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { require.NoError(t, provider.Shutdown(context.Background())) })
	meter := provider.Meter("mcp-contract-test")
	counter, err := meter.Int64Counter("test.mcp.calls")
	require.NoError(t, err)
	duration, err := meter.Int64Histogram("test.mcp.duration")
	require.NoError(t, err)
	oldCounter, oldDuration := paprikametrics.MCPToolCalls, paprikametrics.MCPToolDuration
	paprikametrics.MCPToolCalls, paprikametrics.MCPToolDuration = counter, duration
	t.Cleanup(func() { paprikametrics.MCPToolCalls, paprikametrics.MCPToolDuration = oldCounter, oldDuration })

	for _, isError := range []bool{false, true} {
		r := NewRegistry()
		tool := stubTool("query_metrics", ScopeObserve, false)
		tool.Invoke = func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return &sdkmcp.CallToolResult{IsError: isError, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: "provider result"}}}, nil
		}
		require.NoError(t, r.Register(tool))
		srv := newObservabilityTestServer(t, r, nil)
		body := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","arguments":{}}}`, observeBearerFor(t, ScopeObserve))
		var wire struct {
			Result sdkmcp.CallToolResult `json:"result"`
			Error  json.RawMessage       `json:"error"`
		}
		require.NoError(t, json.Unmarshal(body, &wire))
		assert.Empty(t, wire.Error, "tool failures remain MCP results, not protocol errors")
		assert.Equal(t, isError, wire.Result.IsError)
		require.Len(t, wire.Result.Content, 1)
		content, ok := wire.Result.Content[0].(*sdkmcp.TextContent)
		require.True(t, ok, "the wire result must retain its text content type")
		require.NotNil(t, content)
		assert.Equal(t, "provider result", content.Text)
	}

	var data metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &data))
	counts, durations := map[string]int64{}, map[string]uint64{}
	for _, scope := range data.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			switch points := instrument.Data.(type) {
			case metricdata.Sum[int64]:
				for _, point := range points.DataPoints {
					outcome, ok := point.Attributes.Value(attribute.Key("outcome"))
					require.True(t, ok)
					counts[outcome.AsString()] += point.Value
				}
			case metricdata.Histogram[int64]:
				for _, point := range points.DataPoints {
					outcome, ok := point.Attributes.Value(attribute.Key("outcome"))
					require.True(t, ok)
					durations[outcome.AsString()] += point.Count
				}
			}
		}
	}
	assert.Equal(t, map[string]int64{"ok": 1, "error": 1}, counts)
	assert.Equal(t, map[string]uint64{"ok": 1, "error": 1}, durations)
}
