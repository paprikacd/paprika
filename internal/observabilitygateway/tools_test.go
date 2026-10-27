package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// fakeBackend is a Backend stub recording the calls the tools make, so tool
// behaviour is asserted without a client or a live connector.
type fakeBackend struct {
	providers     []ProviderInfo
	listErr       error
	queryResult   *connector.QueryResult
	queryErr      error
	exploreResult *connector.ExploreResult
	exploreErr    error
	lastProvider  string
	lastReq       connector.QueryRequest
	lastExplore   connector.ExploreRequest
	listCalls     int
	exploreCalls  int
}

func (f *fakeBackend) ListProviders(_ context.Context) ([]ProviderInfo, error) {
	f.listCalls++
	return f.providers, f.listErr
}

func (f *fakeBackend) Query(_ context.Context, provider string, req connector.QueryRequest) (*connector.QueryResult, error) {
	f.lastProvider = provider
	f.lastReq = req
	return f.queryResult, f.queryErr
}

func (f *fakeBackend) Explore(_ context.Context, provider string, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	f.lastProvider = provider
	f.lastExplore = req
	f.exploreCalls++
	return f.exploreResult, f.exploreErr
}

func newRegisteredTools(t *testing.T, b Backend) *mcp.Registry {
	t.Helper()
	reg := mcp.NewRegistry()
	require.NoError(t, RegisterTools(reg, b, nil))
	return reg
}

func invokeTool(t *testing.T, reg *mcp.Registry, name, args string) (any, error) {
	t.Helper()
	tool, ok := reg.Lookup(name)
	require.True(t, ok, "tool %q registered", name)
	return tool.Invoke(context.Background(), nil, json.RawMessage(args))
}

func requireObservedAt(t *testing.T, v any) string {
	t.Helper()
	m, ok := v.(map[string]any)
	require.True(t, ok, "response is a map, got %T", v)
	raw, ok := m["observedAt"].(string)
	require.True(t, ok, "observedAt present and a string in %v", m)
	_, err := time.Parse(time.RFC3339, raw)
	require.NoError(t, err, "observedAt is RFC3339")
	return raw
}

func TestRegisterToolsRegistersAllFifteen(t *testing.T) {
	t.Parallel()

	reg := newRegisteredTools(t, &fakeBackend{})
	for _, name := range []string{
		"list_observability_providers",
		"get_observability_provider",
		"query_metrics",
		"query_logs",
		"query_traces",
		"query_records",
		"list_provider_types",
		"describe_provider_type",
		"validate_provider",
		"list_metric_names",
		"list_metric_series",
		"list_label_names",
		"list_label_values",
		"get_metric_metadata",
		"list_trace_services",
	} {
		tool, ok := reg.Lookup(name)
		require.True(t, ok, "tool %q registered", name)
		require.Equal(t, mcp.ScopeObserve, tool.Scope, "tool %q is observe-scoped", name)
		require.False(t, tool.Destructive, "tool %q is non-destructive", name)
		require.NotEmpty(t, tool.InputSchema, "tool %q has an input schema", name)
	}
}

func TestRegisterToolsPropagatesRegistryError(t *testing.T) {
	t.Parallel()

	reg := mcp.NewRegistry()
	require.NoError(t, reg.Register(mcp.Tool{
		Name:        "query_metrics",
		Description: "occupied",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Invoke: func(_ context.Context, _ v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
			return nil, nil
		},
	}))
	err := RegisterTools(reg, &fakeBackend{}, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), `"query_metrics" already registered`)
}

func TestListProvidersTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{providers: []ProviderInfo{
		{Name: "obs/prom", Namespace: "obs", Type: connector.ProviderPrometheus, State: string(connector.StateOK)},
	}}
	reg := newRegisteredTools(t, b)

	out, err := invokeTool(t, reg, "list_observability_providers", "")
	require.NoError(t, err)
	require.Equal(t, 1, b.listCalls)

	m, ok := out.(map[string]any)
	require.True(t, ok, "response is a map, got %T", out)
	providers, ok := m["providers"].([]ProviderInfo)
	require.True(t, ok)
	require.Len(t, providers, 1)
	require.Equal(t, "obs/prom", providers[0].Name)
	requireObservedAt(t, out)
}

func TestGetProviderTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{providers: []ProviderInfo{
		{Name: "obs/prom", Namespace: "obs", Type: connector.ProviderPrometheus, State: string(connector.StateOK)},
		{Name: "obs/weird", Namespace: "obs", Type: "bogus"},
	}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path advertises connector signals", func(t *testing.T) {
		out, err := invokeTool(t, reg, "get_observability_provider", `{"provider":"obs/prom"}`)
		require.NoError(t, err)
		detail, ok := out.(providerDetail)
		require.True(t, ok, "response is a providerDetail, got %T", out)
		require.Equal(t, "obs/prom", detail.Name)
		require.Equal(t, connector.ProviderPrometheus, detail.Type)
		require.True(t, detail.Supported)
		require.Equal(t, []string{"metrics"}, detail.Signals)
		require.NotEmpty(t, detail.ObservedAt)
	})

	t.Run("unknown type reports unsupported instead of erroring", func(t *testing.T) {
		out, err := invokeTool(t, reg, "get_observability_provider", `{"provider":"obs/weird"}`)
		require.NoError(t, err)
		detail, ok := out.(providerDetail)
		require.True(t, ok, "response is a providerDetail, got %T", out)
		require.False(t, detail.Supported)
		require.Empty(t, detail.Signals)
	})

	t.Run("missing provider argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "get_observability_provider", `{}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("not found becomes a connect NotFound", func(t *testing.T) {
		_, err := invokeTool(t, reg, "get_observability_provider", `{"provider":"obs/missing"}`)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	})
}

func TestQueryMetricsTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{queryResult: &connector.QueryResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"result":[]}`),
	}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path", func(t *testing.T) {
		out, err := invokeTool(t, reg, "query_metrics", `{"provider":"obs/prom","query":"up"}`)
		require.NoError(t, err)
		res := decodeQueryToolResult(t, out)
		require.Equal(t, "obs/prom", res.Provider)
		require.Equal(t, "metrics", res.Signal)
		require.Equal(t, connector.StateOK, res.State)
		require.JSONEq(t, `{"result":[]}`, string(res.Data))
		_, err = time.Parse(time.RFC3339, res.ObservedAt)
		require.NoError(t, err)

		require.Equal(t, "obs/prom", b.lastProvider)
		require.Equal(t, connector.SignalMetrics, b.lastReq.Signal)
		require.Equal(t, "up", b.lastReq.Query)
	})

	t.Run("default window is the trailing thirty minutes", func(t *testing.T) {
		before := time.Now().UTC()
		_, err := invokeTool(t, reg, "query_metrics", `{"provider":"obs/prom","query":"up"}`)
		require.NoError(t, err)
		after := time.Now().UTC()
		require.False(t, b.lastReq.Range.End.IsZero())
		require.False(t, b.lastReq.Range.Start.IsZero())
		require.GreaterOrEqual(t, b.lastReq.Range.End, before)
		require.LessOrEqual(t, b.lastReq.Range.End, after)
		require.Equal(t, defaultQueryWindow, b.lastReq.Range.End.Sub(b.lastReq.Range.Start))
	})

	t.Run("explicit window parses", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_metrics",
			`{"provider":"obs/prom","query":"up","start":"2026-10-12T10:00:00Z","end":"2026-10-12T11:00:00Z"}`)
		require.NoError(t, err)
		require.Equal(t, "2026-10-12T10:00:00Z", b.lastReq.Range.Start.Format(time.RFC3339))
		require.Equal(t, "2026-10-12T11:00:00Z", b.lastReq.Range.End.Format(time.RFC3339))
	})

	t.Run("argument validation", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_metrics", `{"provider":"obs/prom"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

		_, err = invokeTool(t, reg, "query_metrics", `{"provider":"obs/prom","query":"up","start":"not-a-time"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("backend error carries the connect code", func(t *testing.T) {
		b.queryErr = connect.NewError(connect.CodeNotFound, errors.New("observability provider \"obs/prom\" not found"))
		_, err := invokeTool(t, reg, "query_metrics", `{"provider":"obs/prom","query":"up"}`)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		b.queryErr = nil
	})
}

func TestQueryLogsTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{queryResult: &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(`{"data":[]}`)}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path defaults limit to 100", func(t *testing.T) {
		out, err := invokeTool(t, reg, "query_logs", `{"provider":"obs/loki","query":"{app=\"api\"}"}`)
		require.NoError(t, err)
		res := decodeQueryToolResult(t, out)
		require.Equal(t, "logs", res.Signal)
		require.Equal(t, connector.SignalLogs, b.lastReq.Signal)
		require.Equal(t, `{app="api"}`, b.lastReq.Query)
		require.Equal(t, 100, b.lastReq.Limit)
	})

	t.Run("explicit limit passes through", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_logs", `{"provider":"obs/loki","query":"{app=\"api\"}","limit":7}`)
		require.NoError(t, err)
		require.Equal(t, 7, b.lastReq.Limit)
	})

	t.Run("missing query is rejected", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_logs", `{"provider":"obs/loki"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestQueryTracesTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{queryResult: &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(`{}`)}}
	reg := newRegisteredTools(t, b)

	t.Run("trace id query", func(t *testing.T) {
		out, err := invokeTool(t, reg, "query_traces", `{"provider":"obs/tempo","trace_id":"abc123"}`)
		require.NoError(t, err)
		res := decodeQueryToolResult(t, out)
		require.Equal(t, "traces", res.Signal)
		require.Equal(t, connector.SignalTraces, b.lastReq.Signal)
		require.Equal(t, "abc123", b.lastReq.TraceID)
		require.Empty(t, b.lastReq.Query)
	})

	t.Run("traceql query", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_traces", `{"provider":"obs/tempo","query":"{.http.status=500}"}`)
		require.NoError(t, err)
		require.Equal(t, "{.http.status=500}", b.lastReq.Query)
		require.Empty(t, b.lastReq.TraceID)
	})

	t.Run("neither query nor trace id is rejected", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_traces", `{"provider":"obs/tempo"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("missing provider is rejected", func(t *testing.T) {
		_, err := invokeTool(t, reg, "query_traces", `{"trace_id":"abc123"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

// decodeQueryToolResult unwraps the *sdkmcp.CallToolResult the query tools
// now return (full payload in structuredContent, capped text preview) back
// into the queryToolResult the assertions speak in.
func decodeQueryToolResult(t *testing.T, out any) queryToolResult {
	t.Helper()
	result, ok := out.(*sdkmcp.CallToolResult)
	require.True(t, ok, "response is a *sdkmcp.CallToolResult, got %T", out)
	structured, ok := result.StructuredContent.(json.RawMessage)
	require.True(t, ok, "structuredContent should be a json.RawMessage, got %T", result.StructuredContent)
	var decoded queryToolResult
	require.NoError(t, json.Unmarshal(structured, &decoded))
	return decoded
}

// decodeExploreToolResult unwraps the *sdkmcp.CallToolResult the exploration
// tools return into the exploreToolResult the assertions speak in.
func decodeExploreToolResult(t *testing.T, out any) exploreToolResult {
	t.Helper()
	result, ok := out.(*sdkmcp.CallToolResult)
	require.True(t, ok, "response is a *sdkmcp.CallToolResult, got %T", out)
	structured, ok := result.StructuredContent.(json.RawMessage)
	require.True(t, ok, "structuredContent should be a json.RawMessage, got %T", result.StructuredContent)
	var decoded exploreToolResult
	require.NoError(t, json.Unmarshal(structured, &decoded))
	return decoded
}

func TestListMetricNamesTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":["up","go_goroutines"]}`),
	}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path passes prefix and limit", func(t *testing.T) {
		out, err := invokeTool(t, reg, "list_metric_names", `{"provider":"obs/prom","prefix":"go_","limit":50}`)
		require.NoError(t, err)
		require.Equal(t, 1, b.exploreCalls)
		require.Equal(t, "obs/prom", b.lastProvider)
		require.Equal(t, connector.ExploreMetricNames, b.lastExplore.Kind)
		require.Equal(t, "go_", b.lastExplore.Prefix)
		require.Equal(t, 50, b.lastExplore.Limit)
		res := decodeExploreToolResult(t, out)
		require.Equal(t, connector.StateOK, res.State)
		require.Equal(t, "metric_names", res.Kind)
		require.Equal(t, "obs/prom", res.Provider)
		require.JSONEq(t, `{"status":"success","data":["up","go_goroutines"]}`, string(res.Data))
		require.NotEmpty(t, res.ObservedAt)
	})

	t.Run("missing provider argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "list_metric_names", `{"prefix":"up"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestListLabelNamesTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":["instance","job"]}`),
	}}
	reg := newRegisteredTools(t, b)

	out, err := invokeTool(t, reg, "list_label_names", `{"provider":"obs/prom","metric":"http_requests_total"}`)
	require.NoError(t, err)
	require.Equal(t, connector.ExploreLabelNames, b.lastExplore.Kind)
	require.Equal(t, "http_requests_total", b.lastExplore.Metric)
	res := decodeExploreToolResult(t, out)
	require.Equal(t, connector.StateOK, res.State)
	require.Equal(t, "label_names", res.Kind)
}

func TestListLabelValuesTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":["api","worker"]}`),
	}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path requires a label", func(t *testing.T) {
		out, err := invokeTool(t, reg, "list_label_values", `{"provider":"obs/prom","label":"app","metric":"up"}`)
		require.NoError(t, err)
		require.Equal(t, connector.ExploreLabelValues, b.lastExplore.Kind)
		require.Equal(t, "app", b.lastExplore.Label)
		require.Equal(t, "up", b.lastExplore.Metric)
		res := decodeExploreToolResult(t, out)
		require.Equal(t, connector.StateOK, res.State)
		require.Equal(t, "label_values", res.Kind)
	})

	t.Run("missing label argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "list_label_values", `{"provider":"obs/prom"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestGetMetricMetadataTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":{"up":[{"type":"gauge","help":"1 if the target is up","unit":""}]}}`),
	}}
	reg := newRegisteredTools(t, b)

	t.Run("happy path requires a metric", func(t *testing.T) {
		out, err := invokeTool(t, reg, "get_metric_metadata", `{"provider":"obs/prom","metric":"up"}`)
		require.NoError(t, err)
		require.Equal(t, connector.ExploreMetricMetadata, b.lastExplore.Kind)
		require.Equal(t, "up", b.lastExplore.Metric)
		res := decodeExploreToolResult(t, out)
		require.Equal(t, connector.StateOK, res.State)
		require.Equal(t, "metric_metadata", res.Kind)
	})

	t.Run("missing metric argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "get_metric_metadata", `{"provider":"obs/prom"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestListTraceServicesTool(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"tagValues":["api","worker"]}`),
	}}
	reg := newRegisteredTools(t, b)

	out, err := invokeTool(t, reg, "list_trace_services", `{"provider":"obs/tempo"}`)
	require.NoError(t, err)
	require.Equal(t, connector.ExploreTraceServices, b.lastExplore.Kind)
	require.Equal(t, "obs/tempo", b.lastProvider)
	res := decodeExploreToolResult(t, out)
	require.Equal(t, connector.StateOK, res.State)
	require.Equal(t, "trace_services", res.Kind)

	t.Run("missing provider argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "list_trace_services", `{}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestExploreToolsForwardNamespaceParam(t *testing.T) {
	t.Parallel()

	b := &fakeBackend{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":[]}`),
	}}
	reg := newRegisteredTools(t, b)

	for _, tc := range []struct {
		tool string
		args string
	}{
		{"list_metric_names", `{"provider":"obs/cwm","namespace":"AWS/EC2"}`},
		{"list_label_names", `{"provider":"obs/cwm","namespace":"AWS/EC2"}`},
		{"list_label_values", `{"provider":"obs/cwm","label":"InstanceId","namespace":"AWS/EC2"}`},
	} {
		_, err := invokeTool(t, reg, tc.tool, tc.args)
		require.NoError(t, err, tc.tool)
		require.Equal(t, map[string]string{"namespace": "AWS/EC2"}, b.lastExplore.Params, tc.tool)
	}

	t.Run("absent namespace leaves params nil", func(t *testing.T) {
		_, err := invokeTool(t, reg, "list_metric_names", `{"provider":"obs/cwm"}`)
		require.NoError(t, err)
		require.Nil(t, b.lastExplore.Params)
	})
}
