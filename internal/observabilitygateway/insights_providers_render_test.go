package observabilitygateway_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/insights"
	observe "github.com/benebsworth/paprika/internal/observabilitygateway"
)

const providersRenderIssuer = "https://observe.example.test"

type providersRenderBearer struct {
	token string
	base  http.RoundTripper
}

func (b providersRenderBearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(r)
}

// callProvidersOverMCP runs list_insights_providers through the observe MCP
// server over HTTP. The shared observability gateway answers every request with
// status, so the rendered tool result is what an agent sees. Insights turns the
// gateway failure into its sharedCatalog body on the way back.
func callProvidersOverMCP(t *testing.T, status int, retryAfter string, local bool, args map[string]any) *sdkmcp.CallToolResult {
	t.Helper()
	ctx := t.Context()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "{}")
	}))
	t.Cleanup(gateway.Close)

	documents, err := insights.OpenStore(t.TempDir())
	require.NoError(t, err)
	serviceToken := strings.Repeat("s", 48)
	cfg := insights.Config{Token: serviceToken, ObservabilityURL: gateway.URL}
	if local {
		cfg.Providers = []insights.ProviderConfig{{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: "http://prometheus.example.test:9090"}}
	}
	service, err := insights.NewServer(cfg, documents)
	require.NoError(t, err)
	serviceHTTP := httptest.NewServer(service.Handler())
	t.Cleanup(serviceHTTP.Close)

	secret := []byte(strings.Repeat("k", 64))
	rules := []auth.RBACRule{{Subjects: []string{"reader"}, Actions: []string{"admin"}, Resources: []string{"insights"}, Namespaces: []string{"*"}}}
	proxy, err := apiserver.NewInsightsProxy(ctx, auth.Config{Enabled: true, TokenSecret: secret, RBACRules: rules}, serviceHTTP.URL, serviceToken, apiserver.InsightsProxyOptions{ObservabilityIssuer: providersRenderIssuer})
	require.NoError(t, err)
	authoring, err := observe.NewInsightsAuthoringClient(proxy, secret, "https://app.example.test", audit.NoopAuditor{})
	require.NoError(t, err)
	verifier, err := auth.NewSelfSignedAuthenticatorForAudience(secret, mcp.ObservabilityTokenAudience, providersRenderIssuer)
	require.NoError(t, err)
	registry := mcp.NewRegistry()
	require.NoError(t, observe.RegisterInsightsTools(registry, authoring, observe.NewUsageTracker()))
	storeCache, err := cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { _ = storeCache.Close() })
	mcpServer, err := mcp.NewServer(mcp.ServerConfig{Registry: registry, Authenticator: verifier, Confirmer: mcp.NewConfirmer(storeCache, time.Minute), Auditor: audit.NoopAuditor{}, Cache: storeCache, Secret: secret, PublicURL: providersRenderIssuer, ClientID: "observe", RedirectURIs: []string{"http://127.0.0.1/callback"}, RoutePrefix: "/observe", ProtocolPath: "/observe/mcp", Audience: mcp.ObservabilityTokenAudience, SupportedScopes: []mcp.Scope{mcp.ScopeObserve, mcp.ScopeInsightsWrite}, DisableConsoleResources: true, LinkRequestCancellation: true})
	require.NoError(t, err)
	mux := http.NewServeMux()
	mux.Handle("/observe/mcp", mcpServer.Handler())
	front := httptest.NewServer(mux)
	t.Cleanup(front.Close)

	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "reader", Groups: []string{"metrics-readers"}, Audience: mcp.ObservabilityTokenAudience, Issuer: providersRenderIssuer, Scope: string(mcp.ScopeObserve), Secret: secret, TTL: time.Hour})
	require.NoError(t, err)
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "observe-test", Version: "test"}, nil)
	session, err := client.Connect(ctx, &sdkmcp.StreamableClientTransport{Endpoint: front.URL + "/observe/mcp", HTTPClient: &http.Client{Transport: providersRenderBearer{token: token, base: http.DefaultTransport}}, MaxRetries: -1, DisableStandaloneSSE: true}, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	if args == nil {
		args = map[string]any{}
	}
	result, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: "list_insights_providers", Arguments: args})
	require.NoError(t, err, "a degraded catalog is a tool result, not a protocol error")
	return result
}

func textOf(t *testing.T, result *sdkmcp.CallToolResult) []string {
	t.Helper()
	texts := make([]string, 0, len(result.Content))
	for _, content := range result.Content {
		text, ok := content.(*sdkmcp.TextContent)
		require.True(t, ok, "content is %T", content)
		texts = append(texts, text.Text)
	}
	return texts
}

func errorCodeOf(t *testing.T, result *sdkmcp.CallToolResult) map[string]any {
	t.Helper()
	structured, err := json.Marshal(result.StructuredContent)
	require.NoError(t, err)
	var body struct {
		Error map[string]any `json:"error"`
	}
	require.NoError(t, json.Unmarshal(structured, &body))
	return body.Error
}

func TestListInsightsProvidersRendersDegradedCatalogAsToolErrors(t *testing.T) {
	t.Run("busy carries the retry hint", func(t *testing.T) {
		result := callProvidersOverMCP(t, http.StatusTooManyRequests, "2", false, nil)
		require.True(t, result.IsError)
		texts := textOf(t, result)
		require.Len(t, texts, 1)
		require.Contains(t, texts[0], "tool execution capacity is exhausted; retry later.")
		require.Contains(t, texts[0], "Retry after 2 seconds.")
		errBody := errorCodeOf(t, result)
		require.Equal(t, "resource_exhausted", errBody["code"])
		require.Equal(t, float64(2), errBody["retryAfterSeconds"])
	})

	t.Run("forbidden is permission denied", func(t *testing.T) {
		result := callProvidersOverMCP(t, http.StatusForbidden, "", false, nil)
		require.True(t, result.IsError)
		texts := textOf(t, result)
		require.Len(t, texts, 1)
		require.Contains(t, texts[0], "shared observability provider access denied")
		require.Equal(t, "permission_denied", errorCodeOf(t, result)["code"])
	})

	t.Run("provider filter is an invalid argument", func(t *testing.T) {
		result := callProvidersOverMCP(t, http.StatusTooManyRequests, "", false, map[string]any{"provider_id": "abc"})
		require.True(t, result.IsError)
		require.Contains(t, textOf(t, result)[0], "invalid provider ID")
		require.Equal(t, "invalid_argument", errorCodeOf(t, result)["code"])
	})
}

func TestListInsightsProvidersPartialCatalogKeepsListingWithNote(t *testing.T) {
	result := callProvidersOverMCP(t, http.StatusTooManyRequests, "3", true, nil)
	require.False(t, result.IsError)
	texts := textOf(t, result)
	require.Len(t, texts, 2)
	require.Contains(t, texts[0], `"prometheus"`)
	require.Contains(t, texts[0], `"sharedCatalog"`)
	require.Equal(t, "Note: the shared observability catalog is busy, so shared providers are missing from this list. Retry after 3 seconds.", texts[1])
}
