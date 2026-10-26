package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

func TestObservabilityDashboardOversizedEnvelopeCannotOrchestrateFromWorkPool(t *testing.T) {
	var queryCalls, authoringCalls atomic.Int32
	client, err := observabilitygateway.NewInsightsAuthoringClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/insights/query-dashboard":
			queryCalls.Add(1)
			_, _ = io.WriteString(w, `{"schemaVersion":1,"dashboard":{"id":"demo"},"widgets":[],"signals":[],"state":"empty"}`)
		case "/api/insights/dashboards/demo":
			authoringCalls.Add(1)
			w.Header().Set("ETag", `"`+strings.Repeat("a", 64)+`"`)
			_, _ = io.Copy(w, r.Body)
		default:
			http.NotFound(w, r)
		}
	}), []byte(rand.Text()), "https://observe.example.test", nil)
	require.NoError(t, err)
	registry := mcp.NewRegistry()
	require.NoError(t, observabilitygateway.RegisterInsightsTools(registry, client, nil))
	principal := &auth.Principal{Subject: "human", Scopes: []string{"paprika:observe", "paprika:insights:write"}}
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "observe", Version: "test"}, nil)
	for _, tool := range registry.All() {
		server.AddTool(&sdkmcp.Tool{Name: tool.Name, InputSchema: tool.InputSchema}, func(ctx context.Context, request *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
			result, invokeErr := tool.Invoke(auth.WithPrincipal(ctx, principal), nil, request.Params.Arguments)
			if invokeErr != nil {
				return nil, invokeErr
			}
			if response, ok := result.(*sdkmcp.CallToolResult); ok {
				return response, nil
			}
			return &sdkmcp.CallToolResult{StructuredContent: result, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: "saved"}}}, nil
		})
	}
	handler := limitObservabilityProtocolRequests(sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return server }, &sdkmcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true}))
	for _, tc := range []struct {
		name, body  string
		unknownSize bool
		denied      bool
	}{
		{"normal dashboard", dashboardAdmissionEnvelope, false, false},
		{"bounded larger dashboard envelope", dashboardAdmissionEnvelope + strings.Repeat(" ", 16<<10), false, false},
		{"oversized RPC ID", strings.Replace(dashboardAdmissionEnvelope, `"id":1`, `"id":"`+strings.Repeat("x", maxObserveDashboardEnvelopeBytes)+`"`, 1), false, true},
		{"oversized trailing whitespace", dashboardAdmissionEnvelope + strings.Repeat(" ", maxObserveDashboardEnvelopeBytes), false, true},
		{"chunked oversized whitespace", dashboardAdmissionEnvelope + strings.Repeat(" ", maxObserveDashboardEnvelopeBytes), true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := queryCalls.Load()
			response := callDashboardAdmissionMCP(t, handler, tc.body, tc.unknownSize)
			if tc.denied {
				require.Contains(t, response, "dashboard query requires bounded orchestration admission")
				require.Equal(t, before, queryCalls.Load(), "an oversized dashboard envelope must never enter Insights execution")
			} else {
				require.Contains(t, response, `"schemaVersion":1`)
				require.Equal(t, before+1, queryCalls.Load())
			}
		})
	}
	// Large authoring documents still use the ordinary work pool. Only dashboard
	// execution requires the trusted orchestration marker; this is not a new
	// global MCP request-size limit.
	widgets := make([]string, 12)
	for i := range widgets {
		widgets[i] = fmt.Sprintf(`{"id":"widget-%d","title":"Requests","type":"timeseries","providerId":"prometheus","query":%q,"unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}}`, i, "up # "+strings.Repeat("x", 3500))
	}
	document := `{"schemaVersion":1,"id":"demo","title":"Demo","timeRange":"1h","refreshInterval":0,"widgets":[` + strings.Join(widgets, ",") + `]}`
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_dashboard","arguments":{"document":` + document + `}}}`
	require.Greater(t, len(body), maxObserveDashboardEnvelopeBytes)
	response := callDashboardAdmissionMCP(t, handler, body, false)
	require.Contains(t, response, `"uiUrl"`)
	require.Equal(t, int32(1), authoringCalls.Load())
}

func callDashboardAdmissionMCP(t *testing.T, handler http.Handler, body string, unknownSize bool) string {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(body))
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	// No header can confer the trusted server-owned orchestration marker.
	request.Header.Set("Mcp-Name", "query_dashboard")
	if unknownSize {
		request.ContentLength = -1
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.True(t, json.Valid(response.Body.Bytes()), response.Body.String())
	return response.Body.String()
}
