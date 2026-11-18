package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// dataAPITestBody is larger than gziphandler's 1400-byte minimum, so a
// compressed response proves the gzip wrapper is in the chain.
var dataAPITestBody = strings.Repeat("a", 4096)

// dataAPITestPrincipal stands in for RequireObserveScope: it sets the principal
// named by the X-Test-Subject header, or none when the header is empty.
func dataAPITestPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subject := r.Header.Get("X-Test-Subject"); subject != "" {
			r = r.WithContext(auth.WithPrincipal(r.Context(), &auth.Principal{Subject: subject}))
		}
		next.ServeHTTP(w, r)
	})
}

func TestObservabilityDataAPIGzipsAndLimitsEveryDataRoute(t *testing.T) {
	store, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	cfg := &cliConfig{MCPPublicURL: usageTestIssuer, AuthEnabled: true}
	srv, _, _, _, err := buildObservabilityServer(t.Context(), cfg, auth.Config{Enabled: true, TokenSecret: []byte("data-api-secret")}, nil, store, observabilitygateway.DefaultBudgetConfig()) //nolint:dogsled // Only the MCP server's limiter is under test.
	require.NoError(t, err)
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `"`+dataAPITestBody+`"`)
	})
	dataAPI := observabilityDataAPI(srv, dataAPITestPrincipal)

	t.Run("a principal's large response is gzipped", func(t *testing.T) {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/api/query", strings.NewReader("{}"))
		request.Header.Set("X-Test-Subject", "alice")
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		dataAPI(inner).ServeHTTP(recorder, request)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Equal(t, "gzip", recorder.Header().Get("Content-Encoding"))
		reader, err := gzip.NewReader(recorder.Body)
		require.NoError(t, err)
		body, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.Equal(t, `"`+dataAPITestBody+`"`, string(body))
	})

	t.Run("a request without a principal is refused, never passed unlimited", func(t *testing.T) {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/api/providers", http.NoBody)
		recorder := httptest.NewRecorder()
		dataAPI(inner).ServeHTTP(recorder, request)
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
		require.NotContains(t, recorder.Body.String(), dataAPITestBody)
	})
}

// The data routes draw on the same per-subject bucket as /observe/mcp. A subject
// that spends its burst on MCP requests is then throttled on the REST routes.
func TestObservabilityDataRoutesShareTheMCPBucket(t *testing.T) {
	secret := []byte("data-bucket-secret")
	store, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	cfg := &cliConfig{MCPPublicURL: usageTestIssuer, AuthEnabled: true}
	require.NoError(t, validateObservabilityGatewayConfig(cfg))
	kube := fake.NewClientBuilder().WithScheme(newScheme()).Build()
	srv, authenticator, usage, backend, err := buildObservabilityServer(t.Context(), cfg, auth.Config{Enabled: true, TokenSecret: secret}, kube, store, observabilitygateway.DefaultBudgetConfig())
	require.NoError(t, err)
	mux := buildObservabilityMux(srv, authenticator, cfg.MCPPublicURL, usage, backend)
	token := usageTestToken(t, secret, string(mcp.ScopeObserve), string(mcp.ScopeInsightsWrite))

	do := func(method, path, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bucket-test","version":"1"}}}`
	require.Equal(t, http.StatusOK, do(http.MethodGet, "/observe/api/providers", "").Code, "a fresh subject is admitted on REST")

	// Spend the subject's burst on /observe/mcp, then hit the REST routes at once.
	for range 100 {
		require.Equal(t, http.StatusOK, do(http.MethodPost, "/observe/mcp", initialize).Code)
	}
	// Only the limiter's own refusal counts. The admission pools also answer 429,
	// so a bare status would not show that the REST routes share the bucket.
	var wg sync.WaitGroup
	recorders := make([]*httptest.ResponseRecorder, 24)
	for i := range recorders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			recorders[i] = do(http.MethodGet, "/observe/api/providers", "")
		}()
	}
	wg.Wait()
	throttled := 0
	for _, recorder := range recorders {
		if recorder.Code == http.StatusTooManyRequests && strings.Contains(recorder.Body.String(), "rate limit queue is full") {
			throttled++
			require.Equal(t, "1", recorder.Header().Get("Retry-After"), "a limiter refusal names a one-second retry")
		}
	}
	require.Positive(t, throttled, "REST requests must be throttled by the bucket the MCP requests spent")
}
