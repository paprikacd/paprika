package observabilitygateway

import (
	"context"
	"encoding/json"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestProviderToolsMarkNonOKOutcomesAsErrorsAndPreserveData(t *testing.T) {
	t.Parallel()
	tools := map[string]string{
		"query_metrics":       `{"provider":"obs/backend","query":"up"}`,
		"query_logs":          `{"provider":"obs/backend","query":"up"}`,
		"query_traces":        `{"provider":"obs/backend","query":"up"}`,
		"list_metric_names":   `{"provider":"obs/backend"}`,
		"list_label_names":    `{"provider":"obs/backend"}`,
		"list_label_values":   `{"provider":"obs/backend","label":"job"}`,
		"get_metric_metadata": `{"provider":"obs/backend","metric":"up"}`,
		"list_trace_services": `{"provider":"obs/backend"}`,
	}
	data := json.RawMessage(`{"values":["up"],"warnings":["result limit reached; narrow the request"]}`)
	for _, state := range []connector.State{connector.StateOK, connector.StateError, connector.StateForbidden, connector.StateNotConfigured, connector.StateNotAvailable, ""} {
		for name, args := range tools {
			t.Run(name+"/"+string(state), func(t *testing.T) {
				backend := &fakeBackend{
					queryResult:   &connector.QueryResult{State: state, Reason: "provider verdict", Data: data},
					exploreResult: &connector.ExploreResult{State: state, Reason: "provider verdict", Data: data},
				}
				result, err := invokeTool(t, newRegisteredTools(t, backend), name, args)
				require.NoError(t, err, "provider verdicts remain structured tool results")
				out, ok := result.(*sdkmcp.CallToolResult)
				require.True(t, ok)
				require.Equal(t, state != connector.StateOK, out.IsError)
				encoded, err := json.Marshal(out.StructuredContent)
				require.NoError(t, err)
				var payload struct {
					State  connector.State `json:"state"`
					Reason string          `json:"reason"`
					Data   json.RawMessage `json:"data"`
				}
				require.NoError(t, json.Unmarshal(encoded, &payload))
				require.Equal(t, state, payload.State)
				require.Equal(t, "provider verdict", payload.Reason)
				require.JSONEq(t, string(data), string(payload.Data), "partial warnings and provider data must survive failure marking")
			})
		}
	}
}

func TestProviderOutcomeUsageCountsFailedResultsAndOKWarningsSeparately(t *testing.T) {
	t.Parallel()
	tracker := NewUsageTracker()
	backend := &fakeBackend{}
	registry := mcp.NewRegistry()
	require.NoError(t, RegisterTools(registry, backend, tracker))
	for _, state := range []connector.State{connector.StateError, connector.StateForbidden, connector.StateNotConfigured, connector.StateNotAvailable, connector.StateOK} {
		backend.queryResult = &connector.QueryResult{State: state, Data: json.RawMessage(`{"warnings":["partial response"]}`)}
		backend.exploreResult = &connector.ExploreResult{State: state, Data: json.RawMessage(`{"warnings":["partial response"]}`)}
		_, err := invokeTool(t, registry, "query_metrics", `{"provider":"obs/backend","query":"up"}`)
		require.NoError(t, err)
		_, err = invokeTool(t, registry, "list_metric_names", `{"provider":"obs/backend"}`)
		require.NoError(t, err)
	}
	for _, tool := range tracker.Snapshot().Tools {
		require.EqualValues(t, 5, tool.Calls)
		require.EqualValues(t, 4, tool.Errors, "OK with partial-result warnings counts as a successful tool call")
	}
}

func TestFailedToolUsageNeverCopiesProviderContentOrChangesReturn(t *testing.T) {
	t.Parallel()
	tracker := NewUsageTracker()
	result := &sdkmcp.CallToolResult{IsError: true, StructuredContent: map[string]string{"private": "test-only-private-payload"}}
	wrapped := recordUsage(tracker, "query_metrics", func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
		return result, nil
	})
	actual, err := wrapped(context.Background(), nil, nil)
	require.NoError(t, err)
	require.Same(t, result, actual)
	encoded, err := json.Marshal(tracker.Snapshot())
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "test-only-private-payload")
	require.EqualValues(t, 1, tracker.Snapshot().Tools[0].Errors)
}
