package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/cache"
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

// --- Fix round 1 fold-ins: Cache-Control/Pragma, code_verifier length ---

func TestTokenEndpointResponsesCarryNoStoreHeaders(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	// A successful response.
	refresh := seedRefreshToken(t, store, "user-1", "paprika:read")
	ok := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, ok.Code)
	assert.Equal(t, "no-store", ok.Header().Get("Cache-Control"))
	assert.Equal(t, "no-cache", ok.Header().Get("Pragma"))

	// An error response.
	bad := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {"never-issued"},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusBadRequest, bad.Code)
	assert.Equal(t, "no-store", bad.Header().Get("Cache-Control"))
	assert.Equal(t, "no-cache", bad.Header().Get("Pragma"))
}

func TestTokenEndpointRejectsShortCodeVerifier(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	code := seedAuthCode(t, srv.cache, authCodeRecord{
		Subject:       "user-1",
		Scope:         "paprika:read",
		RedirectURI:   redirect,
		CodeChallenge: pkceChallengeForFix1,
		ClientID:      "test",
	})

	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {"too-short"}, // well under 43 chars
		"client_id":     {"test"},
	})
	assert.Equal(t, http.StatusBadRequest, resp.Code,
		"code_verifier shorter than RFC 7636's 43-character floor must be rejected")
}

// --- Fix round 1, Finding 4: authorization code not bound to client_id ---

// seedAuthCode writes an authCodeRecord directly to store, the same way
// seedRefreshToken bypasses the full authorize round trip for refresh
// tokens. This is what lets TestTokenEndpointRejectsAuthCodeIssuedToADifferentClient
// construct a code whose recorded client_id differs from the one at
// exchange time — a scenario the single, globally-registered client_id this
// server currently enforces would otherwise make unreachable end to end
// (both the authorize and token endpoints already require client_id to
// equal the one static configured value), but that a future multi-client
// deployment could hit, and that RFC 6749 section 4.1.3 requires closed
// regardless.
func seedAuthCode(t *testing.T, store *cache.Cache, rec authCodeRecord) string {
	t.Helper()
	code := "code-" + rec.Subject
	payload, err := json.Marshal(rec)
	require.NoError(t, err)
	require.NoError(t, store.Set(context.Background(), authCodeKey(code), payload, authCodeTTL))
	return code
}

func TestTokenEndpointRejectsAuthCodeIssuedToADifferentClient(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	code := seedAuthCode(t, srv.cache, authCodeRecord{
		Subject:       "user-1",
		Scope:         "paprika:read",
		RedirectURI:   redirect,
		CodeChallenge: pkceChallengeForFix1,
		ClientID:      "a-different-client", // NOT srv.clientID ("test")
	})

	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {pkceVerifierForFix1},
		"client_id":     {"test"}, // the server's own, and only, registered client
	})

	assert.Equal(t, http.StatusBadRequest, resp.Code,
		"a code issued to a different client_id must not redeem for this one, body: %s", resp.Body.String())
}

// --- Fix round 1, Finding 2: non-atomic consume permits double-spend ---

// TestConcurrentRefreshTokenRedemptionOnlyOneSucceeds fires N concurrent
// /mcp/token requests redeeming the SAME single-use refresh token and
// asserts exactly one succeeds. Before this fix, consumeRefreshToken did a
// plain Get followed by a separate Delete — two concurrent callers could
// both read the token before either deleted it, so both would mint a live
// successor refresh-token chain from the same predecessor (a double-spend).
// The fix makes consumption atomic via cache.GetDel.
func TestConcurrentRefreshTokenRedemptionOnlyOneSucceeds(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	const n = 200
	token := seedRefreshToken(t, store, "user-1", "paprika:read")

	var wg sync.WaitGroup
	var successes int64
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			resp := postForm(t, mux, "/mcp/token", url.Values{
				"grant_type":    {"refresh_token"},
				"refresh_token": {token},
				"client_id":     {"test"},
			})
			if resp.Code == http.StatusOK {
				atomic.AddInt64(&successes, 1)
			}
		}()
	}
	wg.Wait()

	assert.EqualValues(t, 1, successes,
		"exactly one of %d concurrent redemptions of the same refresh token must succeed", n)
}

// TestConcurrentAuthCodeRedemptionOnlyOneSucceeds is the authorization-code
// counterpart to TestConcurrentRefreshTokenRedemptionOnlyOneSucceeds: N
// concurrent /mcp/token requests redeeming the SAME single-use
// authorization code must yield exactly one success. consumeAuthCode had
// the identical Get-then-Delete non-atomicity Finding 2 describes for
// refresh tokens.
func TestConcurrentAuthCodeRedemptionOnlyOneSucceeds(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	const n = 200
	code := seedAuthCode(t, srv.cache, authCodeRecord{
		Subject:       "user-1",
		Scope:         "paprika:read",
		RedirectURI:   redirect,
		CodeChallenge: pkceChallengeForFix1,
		ClientID:      "test",
	})

	var wg sync.WaitGroup
	var successes int64
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			resp := postForm(t, mux, "/mcp/token", url.Values{
				"grant_type":    {"authorization_code"},
				"code":          {code},
				"redirect_uri":  {redirect},
				"code_verifier": {pkceVerifierForFix1},
				"client_id":     {"test"},
			})
			if resp.Code == http.StatusOK {
				atomic.AddInt64(&successes, 1)
			}
		}()
	}
	wg.Wait()

	assert.EqualValues(t, 1, successes,
		"exactly one of %d concurrent redemptions of the same authorization code must succeed", n)
}

// --- Fix round 1, Finding 1: scope self-escalation at /mcp/authorize ---
//
// These four tests drive the full authorize -> exchange flow the same way
// TestAuthorizeCompletesWithAValidBearerToken does, but with principals whose
// bearer-token scopes deliberately differ from what the authorize request's
// scope= parameter asks for. Every one of them was run against the
// pre-fix code (negotiateScopes, which never consults principal.Scopes) and
// failed — see task-14-report.md's "Fix round 1" section for the captured
// output.
const (
	pkceVerifierForFix1  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	pkceChallengeForFix1 = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
)

// authorizeForFix1 drives GET /mcp/authorize with bearer as the
// authenticated principal and scopeQuery as the raw scope= query value
// (omit entirely when scopeQuery == ""), returning the raw recorder so
// callers can inspect either a redirect or an OAuth error response.
func authorizeForFix1(t *testing.T, mux *http.ServeMux, redirect, bearer, scopeQuery string) *httptest.ResponseRecorder {
	t.Helper()
	q := "/mcp/authorize?client_id=test&response_type=code" +
		"&code_challenge=" + pkceChallengeForFix1 + "&code_challenge_method=S256" +
		"&redirect_uri=" + url.QueryEscape(redirect)
	if scopeQuery != "" {
		q += "&scope=" + url.QueryEscape(scopeQuery)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, q, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	mux.ServeHTTP(rec, req)
	return rec
}

// exchangeForFix1 redeems the code carried in authorizeRec's Location header
// and returns the granted access token's scope, as reported by the MCP
// authenticator that validates it (not merely the token response body,
// which the client cannot be trusted to check).
func exchangeForFix1(t *testing.T, mux *http.ServeMux, redirect string, authorizeRec *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, http.StatusFound, authorizeRec.Code, "body: %s", authorizeRec.Body.String())
	loc, err := url.Parse(authorizeRec.Header().Get("Location"))
	require.NoError(t, err)
	code := loc.Query().Get("code")
	require.NotEmpty(t, code)

	tokenResp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {pkceVerifierForFix1},
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
	return p.Scopes
}

// TestAuthorizeReadOnlyPrincipalCannotEscalateToWrite is Finding 1's
// central regression test: a principal whose bearer token carries only
// paprika:read must never end up with a paprika:write-carrying access
// token, no matter what the authorize request's scope= parameter asks for.
// The chosen policy rejects the whole authorize request with invalid_scope
// rather than silently downgrading — see negotiateScope's doc comment and
// task-14-report.md's "Fix round 1" section for the rationale.
func TestAuthorizeReadOnlyPrincipalCannotEscalateToWrite(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead)
	rec := authorizeForFix1(t, mux, redirect, bearer, string(ScopeWrite))

	assert.Equal(t, http.StatusBadRequest, rec.Code,
		"a read-only principal requesting scope=paprika:write must be rejected outright, not silently downgraded")
	var oerr oauthError
	if rec.Code == http.StatusBadRequest {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
		assert.Equal(t, "invalid_scope", oerr.Error)
	}
}

// TestAuthorizeReadOnlyPrincipalOmittingScopeGetsReadOnly is Finding 1's
// default-grant regression test: omitting scope= must default to exactly
// the principal's own scopes, never to every scope the server supports.
func TestAuthorizeReadOnlyPrincipalOmittingScopeGetsReadOnly(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead)
	rec := authorizeForFix1(t, mux, redirect, bearer, "")
	scopes := exchangeForFix1(t, mux, redirect, rec)

	assert.Equal(t, []string{"paprika:read"}, scopes,
		"omitting scope must default to exactly the principal's own scopes, not every scope the server supports")
}

// TestAuthorizeBothScopedPrincipalRequestingOneGetsOnlyThatOne is Finding
// 1's narrowing regression test: a principal holding both scopes who asks
// for only one of them must be granted only that one.
func TestAuthorizeBothScopedPrincipalRequestingOneGetsOnlyThatOne(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead, ScopeWrite)
	rec := authorizeForFix1(t, mux, redirect, bearer, string(ScopeRead))
	scopes := exchangeForFix1(t, mux, redirect, rec)

	assert.Equal(t, []string{"paprika:read"}, scopes,
		"requesting a single scope out of a principal's two must grant only that one")
}

// TestAuthorizeScopelessPrincipalNeverReceivesADefaultGrant is Finding 1's
// explicitly required floor: a principal carrying no scopes at all (no
// bearer token issued yet is authenticated as unauthenticated and handled
// elsewhere; this is the case of a validly authenticated principal whose
// token simply carries none) must end up with NO scopes — never the
// server's default set.
func TestAuthorizeScopelessPrincipalNeverReceivesADefaultGrant(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t) // no scopes at all
	rec := authorizeForFix1(t, mux, redirect, bearer, "")
	scopes := exchangeForFix1(t, mux, redirect, rec)

	assert.Empty(t, scopes,
		"a scope-less principal must never receive a default grant of every supported scope")
}
