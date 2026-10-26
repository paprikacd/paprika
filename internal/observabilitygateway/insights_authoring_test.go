package observabilitygateway_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/insights"
	observe "github.com/benebsworth/paprika/internal/observabilitygateway"
)

type authoringAudit struct {
	mu     sync.Mutex
	events []audit.Event
}

func (a *authoringAudit) Record(_ context.Context, event audit.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, event)
}

type authoringHarness struct {
	invoker  *mcp.Invoker
	proxy    http.Handler
	token    string
	auditor  *authoringAudit
	registry *mcp.Registry
}

func TestInsightsAuthoringPublicOrigin(t *testing.T) {
	for _, origin := range []string{"https://paprika.example.test?", "https://paprika.example.test#", "https://paprika.example.test/?", "https://paprika.example.test/#", "https://paprika.example.test/path", "https://user@paprika.example.test", "file:///tmp/paprika"} {
		t.Run(origin, func(t *testing.T) {
			_, err := observe.NewInsightsAuthoringClient(http.NotFoundHandler(), []byte(rand.Text()), origin, nil)
			require.Error(t, err)
		})
	}
	for _, origin := range []string{"https://paprika.example.test", "http://localhost:3000/"} {
		_, err := observe.NewInsightsAuthoringClient(http.NotFoundHandler(), []byte(rand.Text()), origin, nil)
		require.NoError(t, err)
	}
}

func newAuthoringHarness(t *testing.T) *authoringHarness {
	t.Helper()
	secret := []byte(rand.Text())
	serviceToken := rand.Text() + rand.Text()
	store, err := insights.OpenStore(t.TempDir())
	require.NoError(t, err)
	service, err := insights.NewServer(insights.Config{Token: serviceToken, Providers: []insights.ProviderConfig{{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"}}}, store)
	require.NoError(t, err)
	upstream := httptest.NewServer(service.Handler())
	t.Cleanup(upstream.Close)
	cfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: []auth.RBACRule{
		{Subjects: []string{"group:editors"}, Actions: []string{"read", "write"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"group:users"}, Actions: []string{"read", "write"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"group:readers"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
	}}
	proxy, err := apiserver.NewInsightsProxy(t.Context(), cfg, upstream.URL, serviceToken)
	require.NoError(t, err)
	auditor := &authoringAudit{}
	authoring, err := observe.NewInsightsAuthoringClient(proxy, secret, "https://paprika.example.test", auditor)
	require.NoError(t, err)
	registry := mcp.NewRegistry()
	require.NoError(t, observe.RegisterInsightsTools(registry, authoring, nil))
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "human", Groups: []string{"editors"}, Audience: auth.ConsoleAPIAudience, Secret: secret})
	require.NoError(t, err)
	return &authoringHarness{invoker: mcp.NewInvoker(registry, nil, nil, auditor), proxy: proxy, token: token, auditor: auditor, registry: registry}
}

func authoringPrincipal(groups []string, write bool) *auth.Principal {
	scopes := []string{string(mcp.ScopeObserve)}
	if write {
		scopes = append(scopes, string(mcp.ScopeInsightsWrite))
	}
	return &auth.Principal{Subject: "human", Groups: groups, Scopes: scopes}
}

func (h *authoringHarness) call(t *testing.T, p *auth.Principal, name string, args any) (map[string]json.RawMessage, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	result, err := h.invoker.Call(auth.WithPrincipal(t.Context(), p), p, name, raw)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &object))
	return object, nil
}

func authoringDocument(t *testing.T, kind, title string) map[string]any {
	t.Helper()
	raw := `{"schemaVersion":1,"id":"mcp-demo","title":"Initial","timeRange":"1h","refreshInterval":0,"widgets":[]}`
	if kind == "saved_query" {
		raw = `{"schemaVersion":1,"id":"mcp-demo","name":"Initial","providerId":"prometheus","kind":"metrics","query":"up","description":"Private query detail","tags":["mcp"]}`
	}
	var document map[string]any
	require.NoError(t, json.Unmarshal([]byte(raw), &document))
	field := "title"
	if kind == "saved_query" {
		field = "name"
	}
	document[field] = title
	return document
}

func TestInsightsAuthoringSharesUIStoreAndRequiresCurrentVersion(t *testing.T) {
	for _, kind := range []string{"saved_query", "dashboard"} {
		t.Run(kind, func(t *testing.T) {
			h := newAuthoringHarness(t)
			p := authoringPrincipal([]string{"editors"}, true)
			document := authoringDocument(t, kind, "Initial")
			created, err := h.call(t, p, "create_"+kind, map[string]any{"document": document})
			require.NoError(t, err)
			var originalETag string
			require.NoError(t, json.Unmarshal(created["etag"], &originalETag))
			require.NotEmpty(t, originalETag)
			fetched, err := h.call(t, p, "get_"+kind, map[string]any{"id": "mcp-demo"})
			require.NoError(t, err)
			require.JSONEq(t, string(created["document"]), string(fetched["document"]))
			_, err = h.call(t, p, "create_"+kind, map[string]any{"document": authoringDocument(t, kind, "Duplicate")})
			require.Equal(t, connect.CodeAborted, connect.CodeOf(err))
			updated, err := h.call(t, p, "update_"+kind, map[string]any{"document": authoringDocument(t, kind, "Updated"), "etag": originalETag})
			require.NoError(t, err)
			require.NotEqual(t, string(created["etag"]), string(updated["etag"]))
			_, err = h.call(t, p, "update_"+kind, map[string]any{"document": document, "etag": originalETag})
			require.Equal(t, connect.CodeAborted, connect.CodeOf(err))
			collection := "dashboards"
			if kind == "saved_query" {
				collection = "saved-queries"
			}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/insights/"+collection+"/mcp-demo", nil)
			req.Header.Set("Authorization", "Bearer "+h.token)
			response := httptest.NewRecorder()
			h.proxy.ServeHTTP(response, req)
			require.Equal(t, http.StatusOK, response.Code)
			require.JSONEq(t, string(updated["document"]), response.Body.String())
			require.Contains(t, string(updated["uiUrl"]), "https://paprika.example.test/dashboard/insights/")
			require.Len(t, h.auditor.events, 4)
			require.True(t, h.auditor.events[0].Success)
			require.Equal(t, "human", h.auditor.events[0].Principal)
			require.Equal(t, "create", h.auditor.events[0].Action)
			require.False(t, h.auditor.events[1].Success)
			events, err := json.Marshal(h.auditor.events)
			require.NoError(t, err)
			require.NotContains(t, string(events), "Private query detail")
			require.NotContains(t, string(events), h.token)
		})
	}
}

func TestInsightsAuthoringScopesAndHumanGroupsCannotEscalate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		groups []string
		write  bool
		code   connect.Code
	}{
		{"readonly OAuth", []string{"editors"}, false, connect.CodeUnknown},
		{"readonly RBAC", []string{"readers"}, true, connect.CodePermissionDenied},
		{"empty groups do not gain legacy users", []string{}, true, connect.CodePermissionDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newAuthoringHarness(t)
			p := authoringPrincipal(tc.groups, tc.write)
			_, err := h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Denied")})
			require.Error(t, err)
			if tc.write {
				require.Equal(t, tc.code, connect.CodeOf(err))
			} else {
				require.ErrorIs(t, err, mcp.ErrScopeDenied)
			}
			allowed := authoringPrincipal([]string{"editors"}, true)
			_, err = h.call(t, allowed, "get_dashboard", map[string]any{"id": "mcp-demo"})
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		})
	}
}

func TestInsightsAuthoringRejectsUnsafeVersionsAndMalformedDocuments(t *testing.T) {
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	for _, etag := range []string{"", "*", `W/"version"`, `"a", "b"`} {
		_, err := h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Unsafe"), "etag": etag})
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
	for _, id := range []string{"../provider-configs/secret", "a/b", "?summary=true"} {
		_, err := h.call(t, p, "get_dashboard", map[string]any{"id": id})
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
	invalid := authoringDocument(t, "dashboard", "Invalid")
	invalid["unknownField"] = true
	_, err := h.call(t, p, "create_dashboard", map[string]any{"document": invalid})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	missingProvider := authoringDocument(t, "saved_query", "Invalid")
	missingProvider["providerId"] = "missing"
	_, err = h.call(t, p, "create_saved_query", map[string]any{"document": missingProvider})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	p.Scopes = []string{string(mcp.ScopeInsightsWrite)}
	_, err = h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "No observe")})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
}

func TestInsightsAuthoringListsAreCompactAndToolsDoNotExposeDeletion(t *testing.T) {
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	_, err := h.call(t, p, "create_saved_query", map[string]any{"document": authoringDocument(t, "saved_query", "Query")})
	require.NoError(t, err)
	queries, err := h.call(t, p, "list_saved_queries", map[string]any{})
	require.NoError(t, err)
	require.Contains(t, string(queries["queries"]), `"etag"`)
	require.NotContains(t, string(queries["queries"]), `"query":`)
	_, err = h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Dashboard")})
	require.NoError(t, err)
	dashboards, err := h.call(t, p, "list_dashboards", map[string]any{})
	require.NoError(t, err)
	require.Contains(t, string(dashboards["dashboards"]), `"widgetCount":0`)
	require.NotContains(t, string(dashboards["dashboards"]), `"widgets"`)
	require.Len(t, h.registry.All(), 10)
	for _, tool := range h.registry.All() {
		require.False(t, strings.HasPrefix(tool.Name, "delete_"))
		require.True(t, json.Valid(tool.InputSchema))
	}
}
