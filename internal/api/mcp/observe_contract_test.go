package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestObserveOAuthDiscoveryFollowsIssuerWithoutSelectingFleet(t *testing.T) {
	mux := http.NewServeMux()
	fleet := newTestServer(t)
	observe := newObservabilityTestServer(t, nil, nil)
	fleet.RegisterOAuthRoutes(mux)
	observe.RegisterOAuthRoutes(mux)
	mux.Handle("/observe/mcp", observe.Handler())

	read := func(path string, out any) {
		t.Helper()
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), out))
	}
	var resource protectedResourceMetadata
	read("/.well-known/oauth-protected-resource/observe/mcp", &resource)
	require.Equal(t, "https://paprika.example/observe/mcp", resource.Resource)
	require.Equal(t, []string{"https://paprika.example/observe"}, resource.AuthorizationServers)
	issuer, err := url.Parse(resource.AuthorizationServers[0])
	require.NoError(t, err)
	var metadata authorizationServerMetadata
	read("/.well-known/oauth-authorization-server"+issuer.Path, &metadata)
	require.Equal(t, issuer.String(), metadata.Issuer)
	require.Equal(t, []string{"paprika:observe"}, metadata.ScopesSupported)
	require.Equal(t, "https://paprika.example/observe/register", metadata.RegistrationEndpoint)
	var fleetMetadata authorizationServerMetadata
	read("/.well-known/oauth-authorization-server", &fleetMetadata)
	assert.Equal(t, "https://paprika.example", fleetMetadata.Issuer)
	assert.NotEqual(t, fleetMetadata.TokenEndpoint, metadata.TokenEndpoint)
}

func TestDynamicClientCannotBorrowStaticRedirects(t *testing.T) {
	srv := newObservabilityTestServer(t, nil, []string{"http://127.0.0.1:8791/static"})
	srv.dynClients["dynamic"] = []string{"http://127.0.0.1:8792/dynamic"}
	assert.True(t, srv.isRegisteredRedirect("test", "http://127.0.0.1:8791/static"))
	assert.True(t, srv.isRegisteredRedirect("dynamic", "http://127.0.0.1:8792/dynamic"))
	assert.False(t, srv.isRegisteredRedirect("dynamic", "http://127.0.0.1:8791/static"))
	assert.False(t, srv.isRegisteredRedirect("unknown", "http://127.0.0.1:8791/static"))
}

func TestObserveGrantRecordsRejectForeignSurfaceAndClient(t *testing.T) {
	for _, tc := range []struct{ name, audience, client string }{
		{"foreign audience", MCPTokenAudience, "test"},
		{"foreign client", ObservabilityTokenAudience, "other"},
		{"legacy unbound record", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newObservabilityTestServer(t, nil, nil)
			payload, err := json.Marshal(refreshRecord{Audience: tc.audience, ClientID: tc.client, Subject: "user", Scope: "paprika:observe"})
			require.NoError(t, err)
			require.NoError(t, srv.cache.Set(t.Context(), refreshKey("test-refresh"), payload, time.Minute))
			mux := http.NewServeMux()
			srv.RegisterOAuthRoutes(mux)
			resp := postForm(t, mux, "/observe/token", url.Values{
				"grant_type": {"refresh_token"}, "client_id": {"test"}, "refresh_token": {"test-refresh"},
			})
			assert.Equal(t, http.StatusBadRequest, resp.Code)
			assert.Contains(t, resp.Body.String(), "invalid_grant")
			assert.NotContains(t, resp.Body.String(), "access_token")
		})
	}

	srv := newObservabilityTestServer(t, nil, nil)
	code, err := srv.issueAuthCode(t.Context(), &authCodeRecord{ClientID: "test", RedirectURI: "http://127.0.0.1:8791/callback", CodeChallenge: pkceChallengeForFix1})
	require.NoError(t, err)
	// Simulate the two surfaces sharing the same configured cache.
	srv.audience = MCPTokenAudience
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	resp := postForm(t, mux, "/observe/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {"test"}, "code": {code},
		"redirect_uri": {"http://127.0.0.1:8791/callback"}, "code_verifier": {pkceVerifierForFix1},
	})
	assert.Equal(t, http.StatusBadRequest, resp.Code)
	assert.Contains(t, resp.Body.String(), "invalid_grant")
}

func TestObserveResourceIndicatorRejectsCrossSurfaceBeforeConsumingToken(t *testing.T) {
	srv := newObservabilityTestServer(t, nil, nil)
	assert.True(t, srv.validResource([]string{"HTTPS://PAPRIKA.EXAMPLE/observe/mcp"}))
	assert.False(t, srv.validResource([]string{"https://paprika.example/mcp"}))
	assert.False(t, srv.validResource([]string{"https://paprika.example/observe/mcp#fragment"}))
	assert.False(t, srv.validResource([]string{"https://paprika.example/observe/mcp", "https://paprika.example/mcp"}))
	rec := httptest.NewRecorder()
	srv.issueTokenPair(t.Context(), rec, "test", "user", "", "", "paprika:observe")
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &pair))
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	args := url.Values{"grant_type": {"refresh_token"}, "client_id": {"test"}, "refresh_token": {pair.RefreshToken}, "resource": {"https://paprika.example/mcp"}}
	resp := postForm(t, mux, "/observe/token", args)
	require.Equal(t, http.StatusBadRequest, resp.Code)
	assert.Contains(t, resp.Body.String(), "invalid_target")
	args.Set("resource", "https://paprika.example/observe/mcp")
	resp = postForm(t, mux, "/observe/token", args)
	assert.Equal(t, http.StatusOK, resp.Code)
}

func TestObserveHTTPDisconnectCancelsModernProtocolTool(t *testing.T) {
	started, stopped, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	r := NewRegistry()
	tool := stubTool("query_metrics", ScopeObserve, false)
	tool.Invoke = func(ctx context.Context, _ v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
		close(started)
		select {
		case <-ctx.Done():
			close(stopped)
			return nil, ctx.Err()
		case <-release:
			return nil, nil
		}
	}
	require.NoError(t, r.Register(tool))
	srv := newObservabilityTestServer(t, r, nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "https://paprika.example/observe/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"contract-test","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}}}`))
	req.Header.Set("Authorization", "Bearer "+observeBearerFor(t, ScopeObserve))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("MCP-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "tools/call")
	req.Header.Set("Mcp-Name", "query_metrics")
	finished := make(chan struct{})
	go func() { defer close(finished); srv.Handler().ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("tool did not start")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP cancellation did not reach tool")
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled request did not finish")
	}
}

func TestObserveRejectsInvalidOrigin(t *testing.T) {
	srv := newObservabilityTestServer(t, nil, nil)
	for _, origin := range []string{"https://untrusted.example", "null", "https://paprika.example/path", "https://user@paprika.example"} {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(`{}`))
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		assert.Equal(t, http.StatusForbidden, rec.Code, origin)
	}
	assert.True(t, srv.validOrigin(nil), "native clients need no Origin")
	assert.True(t, srv.validOrigin([]string{"https://paprika.example"}))
}
