package observabilitygateway

import (
	"bytes"
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
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/jsonschema-go/jsonschema"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

const dashboardQueryFixture = `{"schemaVersion":1,"dashboard":{"id":"service-overview","title":"Service overview","etag":"v1"},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":12},"variables":{"service":"api"},"widgets":[{"id":"rate","title":"Request rate","type":"stat","unit":"req/s","signalId":"s1"},{"id":"trace","title":"Matching traces","type":"traces","unit":"ms","signalId":"s2"}],"savedQueries":[{"id":"requests","etag":"q1"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"series":[{"index":0,"samples":300,"valid":299,"missing":1,"last":{"timestamp":1793008800000,"value":1.234567890123}}]},{"id":"s2","state":"partial","traces":{"returned":100,"statusCounts":{"unknown":100},"examples":[],"examplesTruncated":true}}],"queryCount":{"planned":2,"executed":2,"deduplicated":0},"state":"partial"}`

const dashboardRecordsQueryFixture = `{"schemaVersion":1,"dashboard":{"id":"service-records","title":"Service records","etag":"v1"},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":12},"variables":{},"widgets":[{"id":"services","title":"Service records","type":"plugin","unit":"","signalId":"q1"}],"savedQueries":[],"signals":[{"id":"q1","state":"ok","truncated":true,"providerTruncated":true,"records":{"returned":7,"columns":[{"key":"service","type":"string"},{"key":"requests","label":"Requests","type":"number","unit":"req/s"},{"key":"active","type":"boolean"}],"rows":[["api",0,false],["worker",null,true]],"rowsTruncated":true,"columnsOmitted":1,"metadataTruncated":true}}],"queryCount":{"planned":1,"executed":1,"deduplicated":0},"state":"ok"}`

func TestDashboardQueryRecordsContractAndCompactText(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardRecordsQueryFixture)
	}))
	tool := insightsQueryDashboardTool(c)
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	result, err := tool.Invoke(auth.WithPrincipal(t.Context(), principal), nil, json.RawMessage(`{"id":"service-records"}`))
	require.NoError(t, err)
	wire, ok := result.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	structured, ok := wire.StructuredContent.(json.RawMessage)
	require.True(t, ok)
	require.JSONEq(t, dashboardRecordsQueryFixture, string(structured), "null, zero and false must survive in the authoritative record tuples")
	require.Equal(t, int32(1), calls.Load())
	content, ok := wire.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.Contains(t, content.Text, "returned records=7 (bounded page)")
	require.Contains(t, content.Text, "record preview truncated; omitted columns=1; partial source response")
	require.Contains(t, content.Text, `first record (3/4 columns): "service"="api", "requests"=0, "active"=false`)
	require.NotContains(t, content.Text, "worker", "later record rows belong only in structuredContent")
	require.LessOrEqual(t, len(content.Text), dashboardQueryTextBytes)

	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(tool.OutputSchema, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	var document any
	require.NoError(t, json.Unmarshal(structured, &document))
	require.NoError(t, resolved.Validate(document))
	for _, invalid := range []string{
		strings.Replace(dashboardRecordsQueryFixture, `"returned":7`, `"returned":-1`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `"type":"number"`, `"type":"json"`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `["api",0,false]`, `["api",{"opaque":"object"},false]`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `"rowsTruncated":true`, `"rowsTruncated":"yes"`, 1),
	} {
		require.NoError(t, json.Unmarshal([]byte(invalid), &document))
		require.Error(t, resolved.Validate(document), "records must be an explicit validated output contract")
	}
}

func TestDashboardQueryEmptyAndCompleteRecordText(t *testing.T) {
	for _, count := range []int{0, 2} {
		text := dashboardSignalText(&dashboardTextSignal{ID: "q1", State: "empty", Records: &dashboardTextRecords{Returned: count}}, nil)
		require.Contains(t, text, fmt.Sprintf("returned records=%d (bounded page)", count))
		require.NotContains(t, text, "truncated")
		require.NotContains(t, text, "partial source")
	}
}

func TestDashboardQueryRecordTextBoundsAndScalarHonesty(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
	}{
		{`null`, "null"}, {`0`, "0"}, {`false`, "false"},
		{`1.23456789012345`, "1.23456789012345"}, {`"line\nnext"`, `"line\nnext"`},
		{`{"opaque":"not-a-cell"}`, "[unavailable]"},
	} {
		require.Equal(t, tc.want, dashboardRecordScalarText(json.RawMessage(tc.raw)))
	}
	longCell, err := json.Marshal(strings.Repeat("🫑\n", 200))
	require.NoError(t, err)
	formatted := dashboardRecordScalarText(longCell)
	require.True(t, utf8.ValidString(formatted))
	require.Less(t, len(formatted), 180)
	require.NotContains(t, formatted, "\n")
	require.Contains(t, formatted, `\n`)
	var records dashboardTextRecords
	require.NoError(t, json.Unmarshal([]byte(`{"returned":1,"columns":[{"key":"a"},{"key":"b"},{"key":"c"},{"key":"hidden"}],"rows":[[null,0,false,"omit-me"]]}`), &records))
	var preview strings.Builder
	appendDashboardRecordPreview(&preview, &records)
	require.Contains(t, preview.String(), `first record (3/4 columns): "a"=null, "b"=0, "c"=false`)
	require.NotContains(t, preview.String(), "omit-me")
}

func newDashboardQueryClient(t *testing.T, responder http.Handler) (*InsightsAuthoringClient, *atomic.Int32) {
	t.Helper()
	secret := []byte(rand.Text())
	serviceToken := rand.Text() + rand.Text()
	calls := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/api/query-dashboard", r.URL.Path)
		require.Equal(t, "Bearer "+serviceToken, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		responder.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	cfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: []auth.RBACRule{{Subjects: []string{"group:readers"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}}}}
	proxy, err := apiserver.NewInsightsProxy(t.Context(), cfg, upstream.URL, serviceToken)
	require.NoError(t, err)
	client, err := NewInsightsAuthoringClient(proxy, secret, "https://paprika.example.test", nil)
	require.NoError(t, err)
	return client, calls
}

func TestDashboardQueryUsesObserveReadAndHumanInsightsRead(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.JSONEq(t, `{"id":"service-overview","variables":{"service":"api"}}`, string(body))
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	registry := mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(registry, c, nil))
	tool, found := registry.Lookup("query_dashboard")
	require.True(t, found)
	require.Equal(t, mcp.ScopeObserve, tool.Scope)
	require.False(t, tool.Destructive)
	var output map[string]any
	require.NoError(t, json.Unmarshal(tool.OutputSchema, &output))
	require.Contains(t, output["required"], "signals")
	invoker := mcp.NewInvoker(registry, nil, nil, nil)
	for _, tc := range []struct {
		name   string
		groups []string
		scopes []string
		code   connect.Code
		denied bool
	}{
		{name: "observe read with no authoring consent", groups: []string{"readers"}, scopes: []string{"paprika:observe"}},
		{name: "empty groups stay empty", groups: []string{}, scopes: []string{"paprika:observe"}, code: connect.CodePermissionDenied},
		{name: "wrong human group", groups: []string{"editors"}, scopes: []string{"paprika:observe", "paprika:insights:write"}, code: connect.CodePermissionDenied},
		{name: "write does not imply observe", groups: []string{"readers"}, scopes: []string{"paprika:insights:write"}, denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls.Load()
			p := &auth.Principal{Subject: "human", Groups: tc.groups, Scopes: tc.scopes}
			result, err := invoker.Call(auth.WithPrincipal(t.Context(), p), p, "query_dashboard", json.RawMessage(`{"id":"service-overview","variables":{"service":"api"}}`))
			if tc.denied {
				require.ErrorIs(t, err, mcp.ErrScopeDenied)
			} else if tc.code != 0 {
				require.Equal(t, tc.code, connect.CodeOf(err))
			} else {
				require.NoError(t, err)
				wire, ok := result.(*sdkmcp.CallToolResult)
				require.True(t, ok)
				require.False(t, wire.IsError, "partial telemetry is an honest result, not a tool transport error")
				structured, ok := wire.StructuredContent.(json.RawMessage)
				require.True(t, ok)
				require.JSONEq(t, dashboardQueryFixture, string(structured))
				content, ok := wire.Content[0].(*sdkmcp.TextContent)
				require.True(t, ok)
				text := content.Text
				require.Contains(t, text, "1.234567890123")
				require.Contains(t, text, "returned traces=100 (bounded sample)")
				require.NotContains(t, text, `"samples":300`)
				require.Less(t, len(text), len(dashboardQueryFixture))
				require.Equal(t, before+1, calls.Load())
				return
			}
			require.Equal(t, before, calls.Load(), "denied caller must never reach the Insights service")
		})
	}
}

func TestDashboardQueryRejectsMalformedArgumentsBeforeProxy(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.NotFoundHandler())
	tool := insightsQueryDashboardTool(c)
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	for _, input := range []string{"", "null", "[]", `{}`, `{"id":"../provider-configs"}`, `{"id":"demo","document":{}}`, `{"id":"demo"}{}`, `{"id":"demo","variables":{"service":4}}`, `{"id":"demo","history_points":1.5}`, strings.Repeat(" ", 32<<10) + `{}`} {
		_, err := tool.Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(input))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), input)
	}
	require.Zero(t, calls.Load())
}

func TestDashboardQueryCapsResponseAndSanitizesFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   connect.Code
	}{
		{"oversized summary", http.StatusOK, strings.Repeat(" ", dashboardQueryResponseBytes+1), connect.CodeResourceExhausted},
		{"upstream private failure", http.StatusBadGateway, `{"error":"secret credential detail"}`, connect.CodeUnavailable},
		{"invalid JSON", http.StatusOK, `not-json-secret`, connect.CodeInternal},
		{"wrong summary version", http.StatusOK, strings.Replace(dashboardQueryFixture, `"schemaVersion":1`, `"schemaVersion":2`, 1), connect.CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
			_, err := insightsQueryDashboardTool(c).Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(`{"id":"demo"}`))
			require.Equal(t, tc.code, connect.CodeOf(err))
			require.NotContains(t, err.Error(), "secret")
		})
	}
}

func TestDashboardQueryCompactTextBoundsAndQuotesUntrustedTitles(t *testing.T) {
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &body))
	widgets, signals := make([]any, 0, 48), make([]any, 0, 48)
	for i := range 48 {
		id := strings.Repeat("s", 78) + string(rune('a'+i))
		widgets = append(widgets, map[string]any{"id": id, "title": strings.Repeat("🫑\n", 100), "unit": "req/s", "signalId": id})
		signals = append(signals, map[string]any{"id": id, "state": "ok", "records": map[string]any{
			"returned": 1000, "rowsTruncated": true,
			"columns": []any{map[string]any{"key": "name"}, map[string]any{"key": "count"}, map[string]any{"key": "missing"}},
			"rows":    []any{[]any{strings.Repeat("🫑\n", 80), 0, nil}},
		}})
	}
	body["widgets"], body["signals"] = widgets, signals
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
	require.Contains(t, text, `\n`)
	require.Contains(t, text, "More signals are available")
	require.True(t, utf8.ValidString(text))
}

func TestDashboardQueryCancellationReachesProxy(t *testing.T) {
	entered := make(chan struct{})
	closed := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
			close(closed)
		case <-stop:
		}
	}))
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	ctx, cancel := context.WithTimeout(auth.WithPrincipal(t.Context(), p), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := insightsQueryDashboardTool(c).Invoke(ctx, nil, json.RawMessage(`{"id":"demo"}`))
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("dashboard query did not reach the upstream")
	}
	cancel()
	select {
	case err := <-result:
		require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
	case <-time.After(3 * time.Second):
		t.Fatal("dashboard query did not propagate cancellation")
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request did not receive cancellation")
	}
}

func TestDashboardQueryReadHelperDoesNotChangeAuthoringPermissions(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.NotFoundHandler())
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	_, _, err := c.request(auth.WithPrincipal(t.Context(), p), http.MethodPut, "dashboards/demo", bytes.Repeat([]byte("x"), 4), nil)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Zero(t, calls.Load())
}

func TestDashboardQueryRequiresItsHTTPOrchestrationAdmission(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	ctx := auth.WithPrincipal(t.Context(), principal)
	for _, tc := range []struct {
		name string
		ctx  context.Context
		deny bool
	}{
		{"direct in-process call", ctx, false},
		{"dashboard slot", WithDashboardQueryAdmission(ctx, true), false},
		{"ordinary work slot", WithDashboardQueryAdmission(ctx, false), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls.Load()
			_, err := insightsQueryDashboardTool(c).Invoke(tc.ctx, nil, json.RawMessage(`{"id":"demo"}`))
			if tc.deny {
				require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
				require.Equal(t, before, calls.Load(), "misclassified request must never reach dashboard execution")
			} else {
				require.NoError(t, err)
				require.Equal(t, before+1, calls.Load())
			}
		})
	}
}

func TestDashboardQueryMCPWirePublishesSchemaAndAvoidsPayloadDuplication(t *testing.T) {
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	tool := insightsQueryDashboardTool(c)
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "observe", Version: "test"}, nil)
	server.AddTool(&sdkmcp.Tool{Name: tool.Name, InputSchema: tool.InputSchema, OutputSchema: tool.OutputSchema}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		result, err := tool.Invoke(auth.WithPrincipal(ctx, principal), nil, req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		response, ok := result.(*sdkmcp.CallToolResult)
		if !ok {
			return nil, fmt.Errorf("unexpected dashboard result type %T", result)
		}
		return response, nil
	})
	serverTransport, clientTransport := sdkmcp.NewInMemoryTransports()
	serverSession, err := server.Connect(t.Context(), serverTransport, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, serverSession.Close()) }()
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "reader", Version: "test"}, nil)
	clientSession, err := client.Connect(t.Context(), clientTransport, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, clientSession.Close()) }()
	listing, err := clientSession.ListTools(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, listing.Tools, 1)
	require.NotNil(t, listing.Tools[0].OutputSchema)
	result, err := clientSession.CallTool(t.Context(), &sdkmcp.CallToolParams{Name: "query_dashboard", Arguments: map[string]any{"id": "service-overview"}})
	require.NoError(t, err)
	require.False(t, result.IsError)
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	require.Equal(t, 1, bytes.Count(encoded, []byte(`"samples":300`)), "sample summaries must occur only in structuredContent")
	require.NotContains(t, string(encoded), "\\\"samples\\\"")
	require.Contains(t, string(encoded), `"schemaVersion":1`)
}
