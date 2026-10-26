package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
)

func TestInsightsScopeIsExplicitAndIndependent(t *testing.T) {
	assert.Equal(t, []Scope{ScopeObserve, ScopeInsightsWrite}, ParseScopes("paprika:observe paprika:insights:write"))
	assert.False(t, HasScope([]Scope{ScopeObserve}, ScopeInsightsWrite))
	assert.False(t, HasScope([]Scope{ScopeWrite}, ScopeInsightsWrite))
	assert.False(t, HasScope([]Scope{ScopeInsightsWrite}, ScopeWrite))
	assert.False(t, HasScope([]Scope{ScopeInsightsWrite}, ScopeObserve))
	_, defaults, err := resolveGrants(&ServerConfig{})
	require.NoError(t, err)
	assert.Equal(t, []Scope{ScopeRead, ScopeWrite}, defaults, "fleet defaults must not gain authoring access")
}

func TestInsightsInitializeGuidesReadOnlyClientsToDashboardBundles(t *testing.T) {
	for _, tc := range []struct {
		name, token string
		server      *Server
		insights    bool
	}{
		{"configured Observe with read-only token", observeBearerFor(t, ScopeObserve), newObservabilityTestServer(t, nil, nil, ScopeObserve, ScopeInsightsWrite), true},
		{"Observe without Insights", observeBearerFor(t, ScopeObserve), newObservabilityTestServer(t, nil, nil), false},
		{"fleet", bearerFor(t, ScopeRead), newTestServer(t), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := doJSONRPC(t, tc.server, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, tc.token)
			var envelope struct {
				Result struct {
					Instructions string `json:"instructions"`
				} `json:"result"`
				Error json.RawMessage `json:"error"`
			}
			require.NoError(t, json.Unmarshal(body, &envelope))
			require.Empty(t, envelope.Error)
			instructions := envelope.Result.Instructions
			require.NotEmpty(t, instructions)
			if !tc.insights {
				assert.NotContains(t, instructions, "query_dashboard", "do not advertise a tool unavailable on this surface")
				return
			}
			assert.True(t, strings.HasPrefix(instructions, "Prefer query_dashboard"))
			for _, detail := range []string{"list_dashboards", "get_dashboard", "variables map", "identical queries once", "structuredContent", "not authoring consent", "Discover authorized providers", "exact ETag", "paprika:insights:write"} {
				assert.Contains(t, instructions, detail)
			}
		})
	}
}

func TestInsightsAuthoringScopeConsentAndRefreshPreserveExplicitGrant(t *testing.T) {
	for _, scopes := range [][]string{{string(ScopeObserve)}, {string(ScopeObserve), string(ScopeInsightsWrite)}} {
		t.Run(strings.Join(scopes, " "), func(t *testing.T) {
			srv, mux, clientID, consoleBearer := newNativeOAuthContractServer(t, ScopeObserve, ScopeInsightsWrite)
			code := nativeContractConsentCode(t, mux, clientID, consoleBearer, scopes...)
			response := postForm(t, mux, "/observe/token", url.Values{
				"grant_type": {"authorization_code"}, "client_id": {clientID}, "redirect_uri": {nativeContractRedirect},
				"code": {code}, "code_verifier": {pkceVerifierForFix1}, "resource": {nativeContractResource},
			})
			pair := requireInsightsScopeToken(t, srv, response, scopes)
			refreshed := postForm(t, mux, "/observe/token", url.Values{
				"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {pair.RefreshToken},
				"resource": {nativeContractResource}, "scope": {string(ScopeObserve) + " " + string(ScopeInsightsWrite) + " " + string(ScopeWrite)},
			})
			requireInsightsScopeToken(t, srv, refreshed, scopes)
		})
	}
}

func requireInsightsScopeToken(t *testing.T, srv *Server, response *httptest.ResponseRecorder, scopes []string) tokenResponse {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code)
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &pair))
	assert.Equal(t, strings.Join(scopes, " "), pair.Scope)
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	principal, err := srv.authenticator.Authenticate(auth.WithRequest(t.Context(), request))
	require.NoError(t, err)
	assert.Equal(t, scopes, principal.Scopes)
	assert.NotContains(t, principal.Scopes, string(ScopeWrite))
	return pair
}

func TestInsightsScopeCannotBeGrantedByReadOnlyObserveOrFleet(t *testing.T) {
	for name, srv := range map[string]*Server{"read-only Observe": newObservabilityTestServer(t, nil, nil), "fleet": newTestServer(t)} {
		t.Run(name, func(t *testing.T) {
			_, ok := srv.consentedScope([]string{string(ScopeInsightsWrite)})
			assert.False(t, ok)
		})
	}
	srv, mux, clientID, consoleBearer := newNativeOAuthContractServer(t, ScopeObserve, ScopeInsightsWrite)
	_, ok := srv.consentedScope([]string{string(ScopeWrite)})
	assert.False(t, ok)
	response := postJSON(t, mux, "/observe/authorize/consent", consoleBearer, consentRequest{
		ClientID: clientID, RedirectURI: nativeContractRedirect, State: "insights-contract",
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256", Scopes: []string{string(ScopeWrite)}, Decision: decisionApprove,
	})
	assert.Equal(t, http.StatusBadRequest, response.Code)
}

func TestInsightsAuthoringToolRequiresItsScopeAndIsAdvertisedAsWrite(t *testing.T) {
	registry := NewRegistry()
	require.NoError(t, registry.Register(stubTool("create_saved_query", ScopeInsightsWrite, false)))
	srv := newObservabilityTestServer(t, registry, nil, ScopeObserve, ScopeInsightsWrite)
	for _, scope := range []Scope{ScopeObserve, ScopeWrite} {
		body := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_saved_query","arguments":{}}}`, observeBearerFor(t, scope))
		assert.Contains(t, string(body), `"code":-32001`)
	}
	body := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_saved_query","arguments":{}}}`, observeBearerFor(t, ScopeInsightsWrite))
	assert.NotContains(t, string(body), `"error"`)
	body = doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}`, observeBearerFor(t, ScopeObserve))
	var envelope struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Annotations struct {
					ReadOnly    bool `json:"readOnlyHint"`
					Destructive bool `json:"destructiveHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	require.Len(t, envelope.Result.Tools, 1)
	assert.False(t, envelope.Result.Tools[0].Annotations.ReadOnly)
	assert.False(t, envelope.Result.Tools[0].Annotations.Destructive)
}

func TestInsightsWriteAloneCannotReadTelemetry(t *testing.T) {
	registry := NewRegistry()
	require.NoError(t, registry.Register(stubTool("query_metrics", ScopeObserve, false)))
	srv := newObservabilityTestServer(t, registry, nil, ScopeObserve, ScopeInsightsWrite)
	body := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","arguments":{}}}`, observeBearerFor(t, ScopeInsightsWrite))
	assert.Contains(t, string(body), `"code":-32001`)
}

func TestInsightsNativeDiscoveryAndPendingRequestAdvertiseOnlyAuthoringScopes(t *testing.T) {
	srv, mux, clientID, consoleBearer := newNativeOAuthContractServer(t, ScopeObserve, ScopeInsightsWrite)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/.well-known/oauth-authorization-server", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var metadata authorizationServerMetadata
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &metadata))
	assert.Equal(t, []string{string(ScopeObserve), string(ScopeInsightsWrite)}, metadata.ScopesSupported)
	query := url.Values{"client_id": {clientID}, "redirect_uri": {nativeContractRedirect}, "response_type": {"code"},
		"code_challenge": {pkceChallengeForFix1}, "code_challenge_method": {"S256"}, "resource": {nativeContractResource},
		"scope": {string(ScopeObserve) + " " + string(ScopeInsightsWrite)}}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/authorize?"+query.Encode(), nil)
	request.Header.Set("Accept", "text/html")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, request)
	require.Equal(t, http.StatusFound, rec.Code)
	redirect, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	request = httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/authorize/pending?rid="+url.QueryEscape(redirect.Query().Get("rid")), nil)
	request.Header.Set("Authorization", "Bearer "+consoleBearer)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, request)
	require.Equal(t, http.StatusOK, rec.Code)
	var pending pendingAuthzResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &pending))
	assert.Equal(t, query.Get("scope"), pending.Scope)

	// The client requested both scopes, but the user can approve only reads.
	code := nativeContractConsentCode(t, mux, clientID, consoleBearer, string(ScopeObserve))
	response := postForm(t, mux, "/observe/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {clientID}, "redirect_uri": {nativeContractRedirect},
		"code": {code}, "code_verifier": {pkceVerifierForFix1}, "resource": {nativeContractResource},
	})
	requireInsightsScopeToken(t, srv, response, []string{string(ScopeObserve)})
}

func TestConsoleCredentialRetainsExactGroups(t *testing.T) {
	srv := newTestServer(t)
	for _, groups := range [][]string{nil, {}, {"insights-editors", "metrics-readers"}} {
		t.Run(strings.Join(groups, ","), func(t *testing.T) {
			token, err := srv.mintConsoleCredential(&auth.Principal{Subject: "author", Groups: groups})
			require.NoError(t, err)
			verifier := mustAudienceAuthenticator(t, testSecret, auth.ConsoleAPIAudience, "")
			principal, err := verifier.Authenticate(ctxWithBearer(token))
			require.NoError(t, err)
			assert.Equal(t, append([]string{}, groups...), principal.Groups)
			assert.Empty(t, principal.Scopes, "the console hop must not forward MCP scope claims")
		})
	}
}
