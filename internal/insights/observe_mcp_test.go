package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercise the SDK's legacy negotiation as well as the exact on-wire tool
// contract. Fixture callbacks see tool names/arguments, never REST gateway URLs.
func observeMCPTestGateway(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/observe/mcp", r.URL.Path, "no REST fallback is permitted")
		assert.Equal(t, http.MethodPost, r.Method, "no standalone SSE")
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid MCP request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "server/discover":
			response["error"] = map[string]any{"code": -32601, "message": "legacy protocol"}
		case "initialize":
			response["result"] = map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "observe-fixture", "version": "1"}}
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
			return
		case "tools/list":
			tools := []map[string]any{}
			for name := range observeDataTools {
				tools = append(tools, map[string]any{"name": name, "description": "Read data", "inputSchema": map[string]any{"type": "object"}, "annotations": map[string]bool{"readOnlyHint": true}})
			}
			response["result"] = map[string]any{"tools": tools}
		case "tools/call":
			toolRequest := r.Clone(r.Context())
			toolRequest.URL.Path = "/" + request.Params.Name
			toolRequest.Body = http.NoBody
			if len(request.Params.Arguments) > 0 {
				toolRequest.Body = io.NopCloser(bytes.NewReader(request.Params.Arguments))
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, toolRequest)
			if recorder.Code != http.StatusOK {
				w.WriteHeader(recorder.Code)
				_, _ = w.Write(recorder.Body.Bytes())
				return
			}
			var value map[string]any
			if json.Unmarshal(recorder.Body.Bytes(), &value) != nil {
				t.Errorf("invalid fixture output: %s", recorder.Body)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			failed := value["state"] != nil && value["state"] != "OK"
			response["result"] = map[string]any{"structuredContent": value, "isError": failed, "content": []any{map[string]any{"type": "text", "text": "truncated text must not be used"}}}
		default:
			t.Errorf("unexpected MCP method %q", request.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, response)
	}))
}

func TestObserveMCPConnectionStatusAndRealSDK(t *testing.T) {
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "paprika-observe", Version: "1"}, nil)
	tools := []string{"list_observability_providers", "query_metrics", "list_metric_series", "save_dashboard"}
	for _, name := range tools {
		server.AddTool(&sdkmcp.Tool{Name: name, Description: "Read observability data", InputSchema: map[string]any{"type": "object"}, Annotations: &sdkmcp.ToolAnnotations{ReadOnlyHint: name != "save_dashboard"}}, func(ctx context.Context, request *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
			return &sdkmcp.CallToolResult{StructuredContent: map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}}}, nil
		})
	}
	protocol := sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return server }, &sdkmcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, PropagateRequestCancellation: true})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/observe/mcp", r.URL.Path)
		assert.Equal(t, "Bearer alice", r.Header.Get("Authorization"))
		protocol.ServeHTTP(w, r)
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	w := request(t, s.Handler(), http.MethodGet, "/api/observe-connection", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var status observeConnectionStatus
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &status))
	assert.True(t, status.Configured)
	assert.True(t, status.Connected)
	assert.Equal(t, "mcp", status.Transport)
	assert.Equal(t, 1, status.ProviderCount)
	assert.NotEmpty(t, status.ProtocolVersion)
	assert.Len(t, status.Tools, 3)
	assert.NotContains(t, w.Body.String(), "save_dashboard")
	assert.NotContains(t, w.Body.String(), gateway.URL)
	assert.NotContains(t, w.Body.String(), "alice")
	w = request(t, s.Handler(), http.MethodGet, "/api/observe-connection", nil, nil)
	assert.Equal(t, http.StatusForbidden, w.Code)
	standalone := observeTestService(t, "")
	w = request(t, standalone.Handler(), http.MethodGet, "/api/observe-connection", nil, nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &status))
	assert.False(t, status.Configured)
	assert.False(t, status.Connected)
	assert.Empty(t, status.Tools)
}

func TestObserveMCPRejectsTextOnlyAndMissingReadHints(t *testing.T) {
	for _, mode := range []string{"text", "missing-query", "missing-hint"} {
		t.Run(mode, func(t *testing.T) {
			server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "observe", Version: "1"}, nil)
			for _, name := range []string{"list_observability_providers", "query_metrics"} {
				if mode == "missing-query" && name == "query_metrics" {
					continue
				}
				readOnly := mode != "missing-hint" || name != "query_metrics"
				server.AddTool(&sdkmcp.Tool{Name: name, InputSchema: map[string]any{"type": "object"}, Annotations: &sdkmcp.ToolAnnotations{ReadOnlyHint: readOnly}}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
					if mode == "text" {
						return &sdkmcp.CallToolResult{Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: `{"providers":[]}`}}}, nil
					}
					return &sdkmcp.CallToolResult{StructuredContent: map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}}}, nil
				})
			}
			gateway := httptest.NewServer(sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return server }, &sdkmcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true}))
			defer gateway.Close()
			w := request(t, observeTestService(t, gateway.URL).Handler(), http.MethodGet, "/api/observe-connection", nil, observeHeaders("alice"))
			want := http.StatusServiceUnavailable
			if mode == "text" {
				want = http.StatusBadGateway
			}
			assert.Equal(t, want, w.Code, w.Body.String())
			assert.False(t, strings.Contains(w.Body.String(), `"connected":true`))
		})
	}
}

func TestObserveMCPProtocolErrorsPreserveSafeStatus(t *testing.T) {
	for _, tc := range []struct {
		code int64
		want int
	}{{-32001, 403}, {sdkjsonrpc.CodeInvalidParams, 400}, {sdkjsonrpc.CodeMethodNotFound, 503}, {sdkjsonrpc.CodeInternalError, 502}} {
		err := sanitizeObserveMCPError(&sdkjsonrpc.Error{Code: tc.code, Message: "private diagnostic data"})
		var mapped *observeError
		require.ErrorAs(t, err, &mapped)
		assert.Equal(t, tc.want, mapped.status)
		assert.NotContains(t, mapped.message, "private.invalid")
		assert.NotContains(t, mapped.message, "password")
	}
}

func TestObserveMCPDomainFailuresKeepHTTPStatusThroughSDK(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"resource_exhausted", 429}, {"invalid_argument", 400}, {"permission_denied", 403}, {"unauthenticated", 403},
		{"not_found", 404}, {"deadline_exceeded", 504}, {"canceled", 408}, {"failed_precondition", 503}, {"internal", 502}, {"unknown", 502},
	} {
		t.Run(tc.code, func(t *testing.T) {
			server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "observe", Version: "1"}, nil)
			for _, name := range []string{"list_observability_providers", "query_metrics"} {
				server.AddTool(&sdkmcp.Tool{Name: name, InputSchema: map[string]any{"type": "object"}, Annotations: &sdkmcp.ToolAnnotations{ReadOnlyHint: true}}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
					if req.Params.Name == "list_observability_providers" {
						return &sdkmcp.CallToolResult{StructuredContent: map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}}}, nil
					}
					return &sdkmcp.CallToolResult{IsError: true, StructuredContent: map[string]any{"error": map[string]string{"code": tc.code, "message": "private credential detail"}}, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: "private credential detail"}}}, nil
				})
			}
			gateway := httptest.NewServer(sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return server }, &sdkmcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true}))
			defer gateway.Close()
			s := observeTestService(t, gateway.URL)
			w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
			assert.Equal(t, tc.status, w.Code, w.Body.String())
			assert.NotContains(t, w.Body.String(), "private")
			if tc.status == 429 {
				assert.Equal(t, "1", w.Header().Get("Retry-After"))
			}
		})
	}
}
