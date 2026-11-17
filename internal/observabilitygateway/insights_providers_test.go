package observabilitygateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
	"google.golang.org/genproto/googleapis/rpc/errdetails"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

// providersListingTool registers the gateway Insights tools against a fake
// Insights proxy that answers every providers listing with status and body.
func providersListingTool(t *testing.T, status int, body string) mcp.Tool {
	t.Helper()
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/insights/providers" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	client, err := NewInsightsAuthoringClient(proxy, []byte(rand.Text()), "https://paprika.example.test", nil)
	require.NoError(t, err)
	registry := mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(registry, client, nil))
	tool, ok := registry.Lookup("list_insights_providers")
	require.True(t, ok)
	return tool
}

func listProvidersAs(t *testing.T, tool mcp.Tool) (any, error) {
	t.Helper()
	p := &auth.Principal{Subject: "human", Scopes: []string{string(mcp.ScopeObserve)}}
	ctx := auth.WithPrincipal(context.Background(), p)
	return tool.Invoke(ctx, nil, json.RawMessage(`{}`))
}

func TestListInsightsProvidersMapsDegradedSharedCatalogToErrors(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		code      connect.Code
		retry     time.Duration
		wantRetry bool
	}{
		{
			name:      "busy carries the gateway retry hint",
			body:      `{"providers":[],"sharedCatalog":{"status":"busy","code":429,"message":"too many active observability requests; retry shortly","retryAfter":2}}`,
			code:      connect.CodeResourceExhausted,
			retry:     2 * time.Second,
			wantRetry: true,
		},
		{
			name: "busy without a delay defaults to one second",
			body: `{"providers":[],"sharedCatalog":{"status":"busy","code":429,"message":"too many"}}`,
			code: connect.CodeResourceExhausted, retry: time.Second, wantRetry: true,
		},
		{
			name: "forbidden is permission denied",
			body: `{"providers":[],"sharedCatalog":{"status":"forbidden","code":403,"message":"shared observability provider access denied"}}`,
			code: connect.CodePermissionDenied,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tool := providersListingTool(t, http.StatusOK, tc.body)
			result, err := listProvidersAs(t, tool)
			require.Nil(t, result)
			require.Error(t, err)
			require.Equal(t, tc.code, connect.CodeOf(err))
			values := detailValues(t, err)
			if !tc.wantRetry {
				require.Empty(t, values)
				return
			}
			require.Len(t, values, 1)
			retry, ok := values[0].(*errdetails.RetryInfo)
			require.True(t, ok)
			require.Equal(t, tc.retry, retry.GetRetryDelay().AsDuration())
		})
	}
}

func TestListInsightsProvidersUnavailableCatalogIsToolError(t *testing.T) {
	for _, status := range []string{"unavailable", "failed"} {
		t.Run(status, func(t *testing.T) {
			body := `{"providers":[],"sharedCatalog":{"status":"` + status + `","code":504,"message":"observability gateway request timed out"}}`
			tool := providersListingTool(t, http.StatusOK, body)
			result, err := listProvidersAs(t, tool)
			require.NoError(t, err, "an unavailable catalog is a tool error, not a protocol error")
			callResult, ok := result.(*sdkmcp.CallToolResult)
			require.True(t, ok, "got %T", result)
			require.True(t, callResult.IsError)
			require.Equal(t, map[string]any{"error": map[string]any{"code": "unavailable"}}, callResult.StructuredContent)
			require.Len(t, callResult.Content, 1)
			text, ok := callResult.Content[0].(*sdkmcp.TextContent)
			require.True(t, ok)
			require.Equal(t, "The shared observability provider catalog is unavailable; retry later.", text.Text)
		})
	}
}

func TestListInsightsProvidersRejectsProviderFilter(t *testing.T) {
	tool := providersListingTool(t, http.StatusOK, `{"providers":[{"id":"prometheus","name":"Metrics"}]}`)
	p := &auth.Principal{Subject: "human", Scopes: []string{string(mcp.ScopeObserve)}}
	ctx := auth.WithPrincipal(context.Background(), p)
	result, err := tool.Invoke(ctx, nil, json.RawMessage(`{"provider_id":"abc"}`))
	require.Nil(t, result)
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	require.Contains(t, err.Error(), "invalid provider ID")
}

func TestListInsightsProvidersKeepsHealthyListing(t *testing.T) {
	body := `{"providers":[{"id":"prometheus","name":"Metrics"}]}`
	tool := providersListingTool(t, http.StatusOK, body)
	result, err := listProvidersAs(t, tool)
	require.NoError(t, err)
	raw, ok := result.(json.RawMessage)
	require.True(t, ok, "a healthy listing passes through unchanged, got %T", result)
	require.JSONEq(t, body, string(raw))
}

func TestListInsightsProvidersPartialListingNotesDegradedCatalog(t *testing.T) {
	body := `{"providers":[{"id":"prometheus","name":"Metrics"}],"sharedCatalog":{"status":"busy","code":429,"message":"too many active observability requests; retry shortly","retryAfter":3}}`
	tool := providersListingTool(t, http.StatusOK, body)
	result, err := listProvidersAs(t, tool)
	require.NoError(t, err)
	callResult, ok := result.(*sdkmcp.CallToolResult)
	require.True(t, ok, "a partial listing is a successful tool result, got %T", result)
	require.False(t, callResult.IsError)
	require.Len(t, callResult.Content, 2)
	first, ok := callResult.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.JSONEq(t, body, first.Text)
	note, ok := callResult.Content[1].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.Equal(t, "Note: the shared observability catalog is busy, so shared providers are missing from this list. Retry after 3 seconds.", note.Text)
	require.NotContains(t, note.Text, "\n")
	structured, ok := callResult.StructuredContent.(json.RawMessage)
	require.True(t, ok, "structured content is %T", callResult.StructuredContent)
	require.JSONEq(t, body, string(structured))
}

func TestSharedCatalogNoteNamesEachStatus(t *testing.T) {
	require.Contains(t, sharedCatalogNote("forbidden", 0), "not available to this caller")
	require.Contains(t, sharedCatalogNote("unavailable", 0), "unavailable")
	require.Contains(t, sharedCatalogNote("failed", 0), "unavailable")
	require.Contains(t, sharedCatalogNote("busy", 0), "Retry after 1 seconds.")
}

func TestListInsightsProvidersUndecodableCatalogIsUnavailable(t *testing.T) {
	for _, body := range []string{
		`{"providers":[],"sharedCatalog":{"status":"busy","code":429,"retryAfter":1.5}}`,
		`{"providers":[{"id":"prometheus","name":"Metrics"}],"sharedCatalog":{"status":"busy","code":429,"retryAfter":"2"}}`,
		`{"providers":[],"sharedCatalog":"busy"}`,
	} {
		t.Run(body, func(t *testing.T) {
			tool := providersListingTool(t, http.StatusOK, body)
			result, err := listProvidersAs(t, tool)
			require.NoError(t, err, "an undecodable catalog is a tool error, never a passthrough listing")
			callResult, ok := result.(*sdkmcp.CallToolResult)
			require.True(t, ok, "got %T", result)
			require.True(t, callResult.IsError)
			require.Equal(t, map[string]any{"error": map[string]any{"code": "unavailable"}}, callResult.StructuredContent)
		})
	}
}

func TestListInsightsProvidersNullCatalogIsHealthy(t *testing.T) {
	body := `{"providers":[{"id":"prometheus","name":"Metrics"}],"sharedCatalog":null}`
	tool := providersListingTool(t, http.StatusOK, body)
	result, err := listProvidersAs(t, tool)
	require.NoError(t, err)
	raw, ok := result.(json.RawMessage)
	require.True(t, ok, "a null catalog member is not a degraded catalog, got %T", result)
	require.JSONEq(t, body, string(raw))
}

func TestInsightsToolsMapUnavailableInsightsToToolErrors(t *testing.T) {
	proxy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"upstream private address 10.0.0.7"}`))
	})
	client, err := NewInsightsAuthoringClient(proxy, []byte(rand.Text()), "https://paprika.example.test", nil)
	require.NoError(t, err)
	registry := mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(registry, client, nil))
	p := &auth.Principal{Subject: "human", Scopes: []string{string(mcp.ScopeObserve)}}
	ctx := auth.WithPrincipal(context.Background(), p)
	for _, name := range []string{"list_insights_providers", "list_saved_queries", "list_dashboards"} {
		t.Run(name, func(t *testing.T) {
			tool, ok := registry.Lookup(name)
			require.True(t, ok)
			result, err := tool.Invoke(ctx, nil, json.RawMessage(`{}`))
			require.NoError(t, err, "an unreachable Insights is a tool error, not a protocol error")
			callResult, ok := result.(*sdkmcp.CallToolResult)
			require.True(t, ok, "got %T", result)
			require.True(t, callResult.IsError)
			require.Equal(t, map[string]any{"error": map[string]any{"code": "unavailable"}}, callResult.StructuredContent)
			require.Len(t, callResult.Content, 1)
			text, ok := callResult.Content[0].(*sdkmcp.TextContent)
			require.True(t, ok)
			require.Equal(t, "Insights is unavailable; retry later.", text.Text)
			require.NotContains(t, text.Text, "10.0.0.7")
		})
	}
}

func TestListInsightsProvidersDescriptionStatesTheEmptyListContract(t *testing.T) {
	tool := providersListingTool(t, http.StatusOK, `{"providers":[]}`)
	require.Contains(t, tool.Description, "a successful empty list means no providers are available to this caller")
	require.Contains(t, tool.Description, "retry delay")
}
