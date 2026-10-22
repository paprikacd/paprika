package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func dynamicOnlyConfig(t *testing.T) ServerConfig {
	t.Helper()
	base := newObservabilityTestServer(t, nil, nil)
	return ServerConfig{
		Registry: base.registry, Authenticator: base.authenticator,
		ConsoleAuthenticator: base.authorizeAuthenticator, Cache: base.cache,
		Secret: testSecret, PublicURL: "https://paprika.example",
		RoutePrefix: "/observe", ProtocolPath: "/observe/mcp",
		Audience: ObservabilityTokenAudience, SupportedScopes: []Scope{ScopeObserve},
		DisableConsoleResources: true, AllowDynamicRegistrationOnly: true,
	}
}

func TestDCROnlyRequiresExplicitOptInAndCompleteStaticPair(t *testing.T) {
	for _, tc := range []struct {
		name      string
		allow     bool
		client    string
		redirects []string
		wantError bool
	}{
		{name: "default still requires static client", wantError: true},
		{name: "explicit dynamic only", allow: true},
		{name: "partial client", allow: true, client: "static", wantError: true},
		{name: "partial redirects", allow: true, redirects: []string{"http://127.0.0.1/callback"}, wantError: true},
		{name: "complete static pair", client: "static", redirects: []string{"http://127.0.0.1/callback"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := dynamicOnlyConfig(t)
			cfg.AllowDynamicRegistrationOnly, cfg.ClientID, cfg.RedirectURIs = tc.allow, tc.client, tc.redirects
			srv, err := NewServer(cfg)
			if tc.wantError {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.False(t, srv.clientIDAllowed(context.Background(), ""))
			assert.Empty(t, srv.dynClients, "startup must not register any client")
		})
	}
}

func TestDCROnlyObserveRegistrationStillRequiresConsentAndPKCE(t *testing.T) {
	srv, err := NewServer(dynamicOnlyConfig(t))
	require.NoError(t, err)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	const redirect = "http://127.0.0.1:8791/callback"
	registration := postJSON(t, mux, "/observe/register", "", registrationRequest{RedirectURIs: []string{redirect}, ClientName: "contract-test"})
	require.Equal(t, http.StatusCreated, registration.Code)
	//nolint:tagliatelle // RFC 7591 registration response uses client_id on the wire.
	var client struct {
		ClientID string `json:"client_id"`
	}
	require.NoError(t, json.Unmarshal(registration.Body.Bytes(), &client))
	require.NotEmpty(t, client.ClientID)
	assert.True(t, srv.clientIDAllowed(context.Background(), client.ClientID))
	assert.False(t, srv.clientIDAllowed(context.Background(), ""))
	assert.False(t, srv.clientIDAllowed(context.Background(), "unregistered"))
	assert.Len(t, srv.dynClients, 1)

	consent := consentRequest{ClientID: client.ClientID, RedirectURI: redirect, Scopes: []string{"paprika:observe"}, Decision: decisionApprove}
	unauthenticated := postJSON(t, mux, "/observe/authorize/consent", "", consent)
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.Code)
	withoutPKCE := postJSON(t, mux, "/observe/authorize/consent", consoleBearerFor(t, "observe-user"), consent)
	assert.Equal(t, http.StatusBadRequest, withoutPKCE.Code)
	consent.CodeChallenge, consent.CodeChallengeMethod = pkceChallengeForFix1, "S256"
	approved := postJSON(t, mux, "/observe/authorize/consent", consoleBearerFor(t, "observe-user"), consent)
	require.Equal(t, http.StatusOK, approved.Code, approved.Body.String())
	var handoff consentResponse
	require.NoError(t, json.Unmarshal(approved.Body.Bytes(), &handoff))
	location, err := url.Parse(handoff.RedirectTo)
	require.NoError(t, err)
	code := location.Query().Get("code")
	require.NotEmpty(t, code)
	issued := postForm(t, mux, "/observe/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {client.ClientID},
		"code": {code}, "redirect_uri": {redirect}, "code_verifier": {pkceVerifierForFix1},
		"resource": {"https://paprika.example/observe/mcp"},
	})
	require.Equal(t, http.StatusOK, issued.Code, issued.Body.String())
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(issued.Body.Bytes(), &pair))
	assert.Equal(t, "paprika:observe", pair.Scope)
	_, err = srv.authenticator.Authenticate(ctxWithBearer(pair.AccessToken))
	require.NoError(t, err)
	_, err = mustAudienceAuthenticator(t, testSecret, MCPTokenAudience, testIssuer).Authenticate(ctxWithBearer(pair.AccessToken))
	assert.Error(t, err, "DCR-only observe grants must not authorize fleet access")

	// A second registered client cannot redeem the first client's refresh.
	srv.dynClients["other-registered-client"] = []string{redirect}
	wrongClient := postForm(t, mux, "/observe/token", url.Values{
		"grant_type": {"refresh_token"}, "client_id": {"other-registered-client"}, "refresh_token": {pair.RefreshToken},
	})
	assert.Equal(t, http.StatusBadRequest, wrongClient.Code)
	assert.Contains(t, wrongClient.Body.String(), "invalid_grant")
}
