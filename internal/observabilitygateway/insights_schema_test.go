package observabilitygateway

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/insights"
)

func newInsightsSchemaClient(t *testing.T, responder http.Handler) (*InsightsAuthoringClient, *atomic.Int32) {
	t.Helper()
	secret := []byte(rand.Text())
	serviceToken := rand.Text() + rand.Text()
	if responder == nil {
		store, err := insights.OpenStore(t.TempDir())
		require.NoError(t, err)
		service, err := insights.NewServer(insights.Config{Token: serviceToken}, store)
		require.NoError(t, err)
		responder = service.Handler()
		t.Cleanup(func() { require.Empty(t, store.List(), "schema discovery must not save dashboards") })
	}
	calls := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, http.MethodGet, r.Method)
		require.True(t, strings.HasPrefix(r.URL.Path, "/api/schemas/"))
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

func TestInsightsSchemaUsesObserveAndHumanReadPermission(t *testing.T) {
	c, calls := newInsightsSchemaClient(t, nil)
	registry := mcp.NewRegistry()
	tool := insightsSchemaTool(c)
	require.NoError(t, registry.Register(tool))
	require.Equal(t, mcp.ScopeObserve, tool.Scope)
	require.False(t, tool.Destructive)
	invoker := mcp.NewInvoker(registry, nil, nil, nil)
	for _, tc := range []struct {
		name           string
		groups, scopes []string
		code           connect.Code
		denied         bool
	}{
		{name: "reader needs no authoring scope", groups: []string{"readers"}, scopes: []string{"paprika:observe"}},
		{name: "empty groups", scopes: []string{"paprika:observe"}, code: connect.CodePermissionDenied},
		{name: "wrong group", groups: []string{"editors"}, scopes: []string{"paprika:observe", "paprika:insights:write"}, code: connect.CodePermissionDenied},
		{name: "write scope alone", groups: []string{"readers"}, scopes: []string{"paprika:insights:write"}, denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls.Load()
			p := &auth.Principal{Subject: "human", Groups: tc.groups, Scopes: tc.scopes}
			result, err := invoker.Call(auth.WithPrincipal(t.Context(), p), p, tool.Name, json.RawMessage(`{"kind":"widget"}`))
			if tc.denied {
				require.ErrorIs(t, err, mcp.ErrScopeDenied)
			} else if tc.code != 0 {
				require.Equal(t, tc.code, connect.CodeOf(err))
			} else {
				require.NoError(t, err)
				wire, ok := result.(*sdkmcp.CallToolResult)
				require.True(t, ok)
				require.False(t, wire.IsError)
				structured, ok := wire.StructuredContent.(json.RawMessage)
				require.True(t, ok)
				require.NoError(t, validateInsightsSchemaResponse(structured, "widget"))
				require.Contains(t, string(structured), `"$defs"`)
				require.Contains(t, string(structured), `"queryRef"`)
				require.Contains(t, string(structured), `"id":"service-capacity"`)
				require.Contains(t, string(structured), `"id":"market-composition"`)
				require.Contains(t, string(structured), "display=status-badge")
				require.Contains(t, string(structured), "colorField?:string,colorMin?:number,colorMax?:number")
				require.Contains(t, string(structured), "showStatus?:boolean")
				require.Contains(t, string(structured), "config.showRowNumbers")
				require.Contains(t, string(structured), `range\":\"start`, "MCP schema exposes PostgreSQL range bindings")
				require.Len(t, wire.Content, 1)
				content, ok := wire.Content[0].(*sdkmcp.TextContent)
				require.True(t, ok)
				require.Less(t, len(content.Text), 512)
				require.NotContains(t, content.Text, `"properties"`)
				require.Equal(t, before+1, calls.Load())
				return
			}
			require.Equal(t, before, calls.Load(), "denied callers must never reach the Insights service")
		})
	}
}

func TestInsightsSchemaRejectsUnknownAndDuplicateArguments(t *testing.T) {
	c, calls := newInsightsSchemaClient(t, http.NotFoundHandler())
	tool := insightsSchemaTool(c)
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	for _, input := range []string{"", "null", "[]", `{}`, `{"kind":"dashboard","other":true}`, `{"kind":null}`, `{"kind":4}`, `{"kind":"Dashboard"}`, `{"kind":"../provider-configs"}`, `{"kind":"widget"}{}`, `{"kind":"dashboard","kind":"widget"}`, `{"Kind":"widget"}`, strings.Repeat(" ", 1024) + `{"kind":"widget"}`} {
		_, err := tool.Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(input))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), input)
	}
	require.Zero(t, calls.Load())
	for _, kind := range []string{"dashboard", "widget", "saved_query"} {
		actual, err := decodeInsightsSchemaKind(json.RawMessage(`{"kind":"` + kind + `"}`))
		require.NoError(t, err)
		require.Equal(t, kind, actual)
	}
}

func TestInsightsSchemaBoundsResponseAndSanitizesErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   connect.Code
	}{
		{"oversized", http.StatusOK, strings.Repeat(" ", insightsSchemaResponseBytes+1), connect.CodeResourceExhausted},
		{"private upstream failure", http.StatusBadGateway, `{"error":"secret credential detail"}`, connect.CodeUnavailable},
		{"invalid JSON", http.StatusOK, `secret-not-json`, connect.CodeInternal},
		{"wrong version", http.StatusOK, `{"schemaVersion":2,"kind":"widget","schema":{"type":"object"},"examples":[{}],"notes":[]}`, connect.CodeInternal},
		{"wrong kind", http.StatusOK, `{"schemaVersion":1,"kind":"dashboard","schema":{"type":"object"},"examples":[{}],"notes":[]}`, connect.CodeInternal},
		{"empty schema", http.StatusOK, `{"schemaVersion":1,"kind":"widget","schema":{},"examples":[{}],"notes":[]}`, connect.CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newInsightsSchemaClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
			_, err := insightsSchemaTool(c).Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(`{"kind":"widget"}`))
			require.Equal(t, tc.code, connect.CodeOf(err))
			require.NotContains(t, err.Error(), "secret")
		})
	}
}
