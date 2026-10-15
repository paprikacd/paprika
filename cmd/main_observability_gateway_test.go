package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

const usageTestIssuer = "https://paprika.example"

func TestObservabilityGatewayAllowsDCRWithoutStaticClient(t *testing.T) {
	for _, tc := range []struct {
		name      string
		client    string
		redirects []string
		wantError bool
	}{
		{name: "dynamic only"},
		{name: "complete static pair", client: "existing-client", redirects: []string{"http://127.0.0.1/callback"}},
		{name: "client only", client: "partial", wantError: true},
		{name: "redirect only", redirects: []string{"http://127.0.0.1/callback"}, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &cliConfig{MCPPublicURL: usageTestIssuer, AuthEnabled: true, MCPOAuthClientID: tc.client, MCPOAuthRedirectURIs: tc.redirects}
			err := validateObservabilityGatewayConfig(cfg)
			if tc.wantError {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			store, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, store.Close()) })
			srv, _, _, err := buildObservabilityServer(t.Context(), cfg, auth.Config{Enabled: true, TokenSecret: []byte("test-observe-startup-secret")}, nil, store)
			require.NoError(t, err)
			require.NotNil(t, srv)
		})
	}
}

// usageTestToken mints a paprika-observability token the way the gateway's
// own OAuth flow would: audience-bound to this surface, issued by the public
// URL the authenticator checks, carrying exactly the scopes given.
func usageTestToken(t *testing.T, secret []byte, scopes ...string) string {
	t.Helper()
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Email: "test@example.com", Name: "Test",
		Audience: mcp.ObservabilityTokenAudience, Issuer: usageTestIssuer,
		Scope: strings.Join(scopes, " "), TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)
	return token
}

func newUsageTestMux(t *testing.T) (*http.ServeMux, *observabilitygateway.UsageTracker, []byte) {
	t.Helper()
	secret := []byte("usage-test-secret")
	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(secret, mcp.ObservabilityTokenAudience, usageTestIssuer)
	require.NoError(t, err)
	usage := observabilitygateway.NewUsageTracker()
	mux := http.NewServeMux()
	mux.Handle("GET "+observabilityGatewayRoutePrefix+"/api/usage", usageHandler(authenticator, usageTestIssuer, usage))
	return mux, usage, secret
}

func getUsage(t *testing.T, mux http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestUsageHandlerRequiresAuthentication(t *testing.T) {
	mux, _, _ := newUsageTestMux(t)

	rec := getUsage(t, mux, observabilityGatewayRoutePrefix+"/api/usage", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "resource_metadata=\""+usageTestIssuer+observabilityGatewayRoutePrefix+"/.well-known/oauth-protected-resource\"")

	var body usageError
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "invalid_token", body.Error)
}

func TestUsageHandlerRejectsWrongAudience(t *testing.T) {
	mux, _, secret := newUsageTestMux(t)
	// A fleet-MCP token (paprika-mcp audience) must not read observability
	// usage, even observe-scoped: the audience check fails first.
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Audience: mcp.MCPTokenAudience, Issuer: usageTestIssuer,
		Scope: string(mcp.ScopeObserve), TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	rec := getUsage(t, mux, observabilityGatewayRoutePrefix+"/api/usage", token)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUsageHandlerRejectsMissingScope(t *testing.T) {
	mux, _, secret := newUsageTestMux(t)
	// A valid observability token without the observe scope is authenticated
	// but forbidden — the same distinction the MCP tool gate makes.
	token := usageTestToken(t, secret, string(mcp.ScopeRead))

	rec := getUsage(t, mux, observabilityGatewayRoutePrefix+"/api/usage", token)
	require.Equal(t, http.StatusForbidden, rec.Code)

	var body usageError
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "insufficient_scope", body.Error)
}

func TestUsageHandlerServesSnapshot(t *testing.T) {
	mux, usage, secret := newUsageTestMux(t)
	usage.Record("query_metrics", nil)

	rec := getUsage(t, mux, observabilityGatewayRoutePrefix+"/api/usage", usageTestToken(t, secret, string(mcp.ScopeObserve)))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")

	var snapshot observabilitygateway.UsageSnapshot
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&snapshot))
	require.Len(t, snapshot.Tools, 1)
	assert.Equal(t, "query_metrics", snapshot.Tools[0].Name)
	assert.Equal(t, uint64(1), snapshot.Tools[0].Calls)
	assert.False(t, snapshot.GeneratedAt.IsZero())
}

func TestUsageHandlerRejectsNonGET(t *testing.T) {
	mux, _, secret := newUsageTestMux(t)
	token := usageTestToken(t, secret, string(mcp.ScopeObserve))

	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, observabilityGatewayRoutePrefix+"/api/usage", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	// The route only binds GET; the mux answers 405 before any handler runs.
	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

// TestObservabilityGatewayAddrConfiguration holds the flag and env wiring
// the chart relies on: --observability-gateway-addr answers to
// PAPRIKA_OBSERVABILITY_GATEWAY_ADDR through the same viper convention as
// --repo-server-addr.
func TestObservabilityGatewayAddrConfiguration(t *testing.T) {
	var actual *cliConfig
	cmd, _, _ := newManagerCommand(func(_ context.Context, cfg *cliConfig) error { actual = cfg; return nil })
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"api", "--observability-gateway-addr=http://gateway:8090"})
	require.NoError(t, cmd.Execute())
	require.Equal(t, "http://gateway:8090", actual.ObservabilityGatewayAddr)

	t.Setenv("PAPRIKA_OBSERVABILITY_GATEWAY_ADDR", "http://env-gateway:8090")
	cmd2, _, _ := newManagerCommand(func(_ context.Context, cfg *cliConfig) error { actual = cfg; return nil })
	cmd2.SetOut(&bytes.Buffer{})
	cmd2.SetErr(&bytes.Buffer{})
	cmd2.SetArgs([]string{"api"})
	require.NoError(t, cmd2.Execute())
	require.Equal(t, "http://env-gateway:8090", actual.ObservabilityGatewayAddr)
}

func TestQueryOnlyObservabilityDiscoveryFlag(t *testing.T) {
	cfg, err := parseManagerConfig([]string{"--observability-discovery-enabled=false"}, nil)
	require.NoError(t, err)
	assert.False(t, cfg.ObservabilityDiscoveryEnabled, "query-only deployment must not start the provider discovery writer")
}

func TestObservabilityRequestSlotsCoverResponseWriting(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	defer close(release)
	limited := limitObservabilityProtocolRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		entered <- struct{}{}
		<-release // Represents an admitted call still writing to a slow reader.
		w.WriteHeader(http.StatusOK)
	}))
	completed := make(chan struct{}, 4)
	for range 4 {
		go func() {
			limited.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/observe/mcp", nil))
			completed <- struct{}{}
		}()
	}
	for range 4 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("admitted request did not enter handler")
		}
	}
	rec := httptest.NewRecorder()
	limited.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/observe/mcp", nil))
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
	health := httptest.NewRecorder()
	limited.ServeHTTP(health, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", nil))
	require.Equal(t, http.StatusOK, health.Code)
	// Release the admitted writers and prove their slots become reusable.
	for range 4 {
		release <- struct{}{}
	}
	for range 4 {
		<-completed
	}
	rec = httptest.NewRecorder()
	go func() { release <- struct{}{} }()
	limited.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/observe/mcp", nil))
	require.Equal(t, http.StatusOK, rec.Code)
}
