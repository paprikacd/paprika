package observabilitygateway

import (
	"encoding/json"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExploreToolsPreserveDashboardRanges(t *testing.T) {
	start := time.Date(2026, 10, 26, 3, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	for _, name := range []string{"list_metric_names", "list_label_names", "list_label_values", "get_metric_metadata", "list_trace_services", "list_metric_series"} {
		t.Run(name, func(t *testing.T) {
			backend := &fakeBackend{exploreResult: &connector.ExploreResult{State: connector.StateOK, Data: json.RawMessage(`{"status":"success","data":[]}`)}}
			registry := newRegisteredTools(t, backend)
			arguments := map[string]any{"provider": "observability/prometheus", "limit": 123, "start": start.Format(time.RFC3339), "end": end.Format(time.RFC3339)}
			if name == "list_metric_series" || name == "get_metric_metadata" || name == "list_label_names" || name == "list_label_values" {
				arguments["metric"] = "http_requests_total"
			}
			if name == "list_label_values" {
				arguments["label"] = "service"
			}
			raw, err := json.Marshal(arguments)
			require.NoError(t, err)
			_, err = invokeTool(t, registry, name, string(raw))
			require.NoError(t, err)
			require.Equal(t, 1, backend.exploreCalls)
			require.Equal(t, start, backend.lastExplore.Range.Start)
			require.Equal(t, end, backend.lastExplore.Range.End)
			require.Equal(t, 123, backend.lastExplore.Limit)
			if name == "list_metric_series" {
				require.Equal(t, connector.ExploreMetricSeries, backend.lastExplore.Kind)
				require.Equal(t, "http_requests_total", backend.lastExplore.Metric)
			}
			tool, ok := registry.Lookup(name)
			require.True(t, ok)
			var schema struct{ Properties map[string]json.RawMessage }
			require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
			require.Contains(t, schema.Properties, "start")
			require.Contains(t, schema.Properties, "end")
		})
	}
}

func TestExploreToolsRejectInvalidRangesBeforeCallingProvider(t *testing.T) {
	for _, bounds := range []map[string]any{
		{"start": 123},
		{"end": "invalid"},
		{"start": "2026-10-26T04:00:00Z", "end": "2026-10-26T03:00:00Z"},
		{"start": "2026-08-01T00:00:00Z", "end": "2026-10-26T03:00:00Z"},
	} {
		for _, name := range []string{"list_metric_names", "list_label_names", "list_label_values", "get_metric_metadata", "list_trace_services", "list_metric_series"} {
			backend := &fakeBackend{}
			arguments := map[string]any{"provider": "observability/prometheus", "metric": "http_requests_total", "label": "service"}
			for key, value := range bounds {
				arguments[key] = value
			}
			raw, err := json.Marshal(arguments)
			require.NoError(t, err)
			_, err = invokeTool(t, newRegisteredTools(t, backend), name, string(raw))
			require.Error(t, err, name)
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			require.Zero(t, backend.exploreCalls)
		}
	}
}

func TestExploreToolsRetainOptionalRangeDefaults(t *testing.T) {
	backend := &fakeBackend{exploreResult: &connector.ExploreResult{State: connector.StateOK, Data: json.RawMessage(`{"status":"success","data":[]}`)}}
	registry := newRegisteredTools(t, backend)
	_, err := invokeTool(t, registry, "list_metric_names", `{"provider":"observability/prometheus"}`)
	require.NoError(t, err)
	require.True(t, backend.lastExplore.Range.Start.IsZero())
	require.True(t, backend.lastExplore.Range.End.IsZero())
	_, err = invokeTool(t, registry, "list_metric_series", `{"provider":"observability/prometheus","metric":"http_requests_total"}`)
	require.NoError(t, err)
	require.Equal(t, defaultQueryWindow, backend.lastExplore.Range.End.Sub(backend.lastExplore.Range.Start))
}
