package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProtectedResourceMetadata(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t).RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/.well-known/oauth-protected-resource", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var meta struct {
		Resource             string   `json:"resource"`
		AuthorizationServers []string `json:"authorization_servers"`
		ScopesSupported      []string `json:"scopes_supported"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &meta))
	assert.NotEmpty(t, meta.AuthorizationServers)
	assert.ElementsMatch(t, []string{"paprika:read", "paprika:write"}, meta.ScopesSupported)
}

func TestAuthorizationServerMetadata(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t).RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/.well-known/oauth-authorization-server", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var meta struct {
		Issuer                 string   `json:"issuer"`
		AuthorizationEndpoint  string   `json:"authorization_endpoint"`
		TokenEndpoint          string   `json:"token_endpoint"`
		GrantTypesSupported    []string `json:"grant_types_supported"`
		ResponseTypesSupported []string `json:"response_types_supported"`
		CodeChallengeMethods   []string `json:"code_challenge_methods_supported"`
		ScopesSupported        []string `json:"scopes_supported"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &meta))
	assert.NotEmpty(t, meta.Issuer)
	assert.NotEmpty(t, meta.AuthorizationEndpoint)
	assert.NotEmpty(t, meta.TokenEndpoint)
	assert.ElementsMatch(t, []string{"authorization_code", "refresh_token"}, meta.GrantTypesSupported)
	assert.Contains(t, meta.ResponseTypesSupported, "code")
	assert.Contains(t, meta.CodeChallengeMethods, "S256")
	assert.ElementsMatch(t, []string{"paprika:read", "paprika:write"}, meta.ScopesSupported)
}

func TestAuthorizeRejectsUnregisteredRedirectURI(t *testing.T) {
	srv := newTestServerWithRedirects(t, []string{"https://claude.ai/api/mcp/auth_callback"})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	for _, redirect := range []string{
		"https://evil.example/callback",
		"https://claude.ai/api/mcp/auth_callback/../../evil",
		"https://claude.ai.evil.example/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback?x=1",
	} {
		t.Run(redirect, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
				"/mcp/authorize?client_id=test&response_type=code"+
					"&code_challenge=abc&code_challenge_method=S256"+
					"&redirect_uri="+url.QueryEscape(redirect), nil)
			mux.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusBadRequest, rec.Code,
				"redirect_uri matching must be exact, never prefix or suffix")
			assert.NotContains(t, rec.Header().Get("Location"), "evil",
				"must never redirect to an unregistered URI")
		})
	}
}

func TestAuthorizeAcceptsExactRegisteredRedirectURI(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil)
	mux.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusBadRequest, rec.Code)
}

// TestAuthorizeCompletesWithAValidBearerToken drives the authorization
// endpoint all the way to a redirect, using a valid Paprika bearer token —
// obtained, in production, only after the existing Google OIDC login — to
// stand in for an authenticated browser. It then exchanges the resulting
// code at /mcp/token and checks the minted access token carries the
// identity and scope the authorize request granted.
func TestAuthorizeCompletesWithAValidBearerToken(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect)+"&state=xyz&scope=paprika:read", nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(loc.String(), redirect))
	assert.Equal(t, "xyz", loc.Query().Get("state"))
	code := loc.Query().Get("code")
	require.NotEmpty(t, code)

	tokenResp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, tokenResp.Code, tokenResp.Body.String())

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var body struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(tokenResp.Body.Bytes(), &body))

	mcpAuth := mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer)
	p, err := mcpAuth.Authenticate(ctxWithBearer(body.AccessToken))
	require.NoError(t, err)
	assert.Equal(t, "test-user", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)
}

func TestAuthorizeRejectsWrongResponseType(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=token"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil)
	mux.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAuthorizeRejectsMissingPKCE(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&redirect_uri="+url.QueryEscape(redirect), nil)
	mux.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestRefreshTokenRotatesAndRevokesPredecessor(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	first := seedRefreshToken(t, store, "user-1", "paprika:read")

	firstResp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {first},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, firstResp.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
	}
	require.NoError(t, json.Unmarshal(firstResp.Body.Bytes(), &body))
	require.NotEmpty(t, body.AccessToken)
	require.NotEmpty(t, body.RefreshToken)
	assert.Equal(t, "Bearer", body.TokenType)
	assert.NotEqual(t, first, body.RefreshToken, "refresh tokens must rotate")

	replay := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {first},
		"client_id":     {"test"},
	})
	assert.Equal(t, http.StatusBadRequest, replay.Code,
		"a rotated refresh token must not work twice")
}

func TestIssuedAccessTokenCarriesMCPAudience(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	refresh := seedRefreshToken(t, store, "user-1", "paprika:read")
	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, resp.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var body struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &body))

	// The MCP authenticator must accept it, and the console one must not.
	mcpAuth := mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer)
	p, err := mcpAuth.Authenticate(ctxWithBearer(body.AccessToken))
	require.NoError(t, err)
	assert.Equal(t, "user-1", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)

	apiAuth := mustAudienceAuthenticator(t, testSecret, "paprika-api", testIssuer)
	_, err = apiAuth.Authenticate(ctxWithBearer(body.AccessToken))
	assert.Error(t, err, "an MCP token must not be replayable against the console API")
}

func TestTokenEndpointRejectsUnsupportedGrant(t *testing.T) {
	srv, _ := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type": {"password"},
		"username":   {"admin"},
		"password":   {"hunter2"},
	})
	assert.Equal(t, http.StatusBadRequest, resp.Code,
		"only authorization_code and refresh_token are supported")
}

func TestTokenEndpointRejectsUnknownRefreshToken(t *testing.T) {
	srv, _ := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {"never-issued"},
	})
	assert.Equal(t, http.StatusBadRequest, resp.Code)
}
