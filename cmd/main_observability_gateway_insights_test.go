package main

import (
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

func TestObservabilityInsightsRegistrationRequiresExplicitConfiguration(t *testing.T) {
	secret := []byte(rand.Text())
	for _, tc := range []struct {
		name, endpoint, token, publicURL string
		authEnabled                      bool
		secret                           []byte
		wantAuthoring, wantError         bool
	}{
		{name: "unconfigured remains read-only", publicURL: usageTestIssuer},
		{name: "configured adds authoring", endpoint: "http://insights:8090", token: strings.Repeat("fixture", 8), publicURL: usageTestIssuer, authEnabled: true, secret: secret, wantAuthoring: true},
		{name: "disabled authentication", endpoint: "http://insights:8090", token: strings.Repeat("fixture", 8), publicURL: usageTestIssuer, secret: secret, wantError: true},
		{name: "missing signing secret", endpoint: "http://insights:8090", token: strings.Repeat("fixture", 8), publicURL: usageTestIssuer, authEnabled: true, wantError: true},
		{name: "missing service token", endpoint: "http://insights:8090", publicURL: usageTestIssuer, authEnabled: true, secret: secret, wantError: true},
		{name: "invalid service destination", endpoint: "https://fixture:" + rand.Text() + "@insights:8090", token: strings.Repeat("fixture", 8), publicURL: usageTestIssuer, authEnabled: true, secret: secret, wantError: true},
		{name: "invalid public origin", endpoint: "http://insights:8090", token: strings.Repeat("fixture", 8), publicURL: "https://paprika.example/private", authEnabled: true, secret: secret, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAPRIKA_INSIGHTS_URL", tc.endpoint)
			t.Setenv("PAPRIKA_INSIGHTS_TOKEN", tc.token)
			registry := mcp.NewRegistry()
			scopes, err := registerObservabilityInsights(t.Context(), registry, nil, auth.Config{Enabled: tc.authEnabled, TokenSecret: tc.secret}, tc.publicURL, nil)
			if tc.wantError {
				require.Error(t, err)
				require.Empty(t, scopes)
				require.Empty(t, registry.All(), "invalid configuration must not expose authoring tools")
				return
			}
			require.NoError(t, err)
			if !tc.wantAuthoring {
				require.Equal(t, []mcp.Scope{mcp.ScopeObserve}, scopes)
				require.Empty(t, registry.All())
				return
			}
			require.Equal(t, []mcp.Scope{mcp.ScopeObserve, mcp.ScopeInsightsWrite}, scopes)
			require.Len(t, registry.All(), 10)
			for _, name := range []string{"create_saved_query", "update_saved_query", "create_dashboard", "update_dashboard"} {
				tool, found := registry.Lookup(name)
				require.True(t, found, name)
				require.Equal(t, mcp.ScopeInsightsWrite, tool.Scope, name)
				require.False(t, tool.Destructive, name)
			}
		})
	}
}

func TestObservabilityAuthoringReservesBoundedProviderDiscoverySlots(t *testing.T) {
	entered := make(chan struct{}, 8)
	completed := make(chan int, 8)
	release := make(chan struct{}, 8)
	defer close(release)
	limited := limitObservabilityProtocolRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("hold") == "true" {
			entered <- struct{}{}
			<-release
		}
		w.WriteHeader(http.StatusOK)
	}))
	startHeld := func(method, path string) {
		t.Helper()
		req := httptest.NewRequestWithContext(t.Context(), method, path+"?hold=true", nil)
		go func() {
			rec := httptest.NewRecorder()
			limited.ServeHTTP(rec, req)
			completed <- rec.Code
		}()
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("request did not acquire its available slot")
		}
	}
	check := func(method, path string, status int) {
		t.Helper()
		rec := httptest.NewRecorder()
		limited.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), method, path, nil))
		require.Equal(t, status, rec.Code, method+" "+path)
		if status == http.StatusTooManyRequests {
			require.Equal(t, "1", rec.Header().Get("Retry-After"))
		}
	}
	for range 4 {
		startHeld(http.MethodPost, "/observe/mcp")
	}
	check(http.MethodGet, "/observe/api/providers", http.StatusOK)
	for range 4 {
		startHeld(http.MethodGet, "/observe/api/providers")
	}
	check(http.MethodGet, "/observe/api/providers", http.StatusTooManyRequests)
	for _, path := range []string{"/observe/mcp", "/observe/api/query", "/observe/api/explore", "/observe/api/providers"} {
		check(http.MethodPost, path, http.StatusTooManyRequests)
	}
	check(http.MethodGet, "/healthz", http.StatusOK)
	for range 8 {
		release <- struct{}{}
	}
	for range 8 {
		select {
		case code := <-completed:
			require.Equal(t, http.StatusOK, code)
		case <-time.After(2 * time.Second):
			t.Fatal("completed request did not release its slot")
		}
	}
	check(http.MethodGet, "/observe/api/providers", http.StatusOK)
	check(http.MethodPost, "/observe/mcp", http.StatusOK)
}
