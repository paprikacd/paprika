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

	bearer := bearerFor(t, ScopeRead)

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
			req.Header.Set("Authorization", "Bearer "+bearer)
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

// TestAuthorizeUnauthenticatedRequestsAreIndistinguishable is the CF5 oracle
// test (task-15-report.md): handleAuthorize now authenticates before it
// validates anything else, so an unauthenticated caller gets an identical
// 401 response regardless of whether the redirect_uri it supplied is
// registered, unregistered, or missing entirely — closing the enumeration
// oracle a differently-shaped failure would otherwise provide.
func TestAuthorizeUnauthenticatedRequestsAreIndistinguishable(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	registered := httptest.NewRecorder()
	mux.ServeHTTP(registered, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil))

	unregistered := httptest.NewRecorder()
	mux.ServeHTTP(unregistered, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape("https://evil.example/callback"), nil))

	require.Equal(t, http.StatusUnauthorized, registered.Code)
	require.Equal(t, http.StatusUnauthorized, unregistered.Code)
	assert.Equal(t, registered.Code, unregistered.Code)
	assert.Equal(t, registered.Body.String(), unregistered.Body.String(),
		"an unauthenticated caller must not be able to tell a registered redirect_uri from an unregistered one")
	assert.Equal(t, registered.Header().Get("WWW-Authenticate"), unregistered.Header().Get("WWW-Authenticate"))
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
	req.Header.Set("Authorization", "Bearer "+bearerFor(t, ScopeRead))
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
	req.Header.Set("Authorization", "Bearer "+bearerFor(t, ScopeRead))
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
		"client_id":  {"test"},
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
		"client_id":     {"test"},
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

	// A start barrier: every goroutine signals ready, then blocks on start.
	// Only once all n goroutines have signalled ready (i.e. are actually
	// parked on the channel receive, not merely spawned-but-not-yet-
	// scheduled) does the main goroutine close(start), releasing them all
	// in the same instant. The ready rendezvous matters: without it,
	// close(start) can run before most goroutines have even been scheduled
	// for the first time, so they simply see an already-closed channel and
	// never actually contend — which is why an earlier, ready-less version
	// of this barrier barely improved on the original 1-3/30 failure rate.
	// See Fix round 2 Fold-in 1.
	start := make(chan struct{})
	ready := make(chan struct{}, n)
	var wg sync.WaitGroup
	var successes int64
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			ready <- struct{}{}
			<-start
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
	for i := 0; i < n; i++ {
		<-ready
	}
	close(start)
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

	// Start barrier with a ready rendezvous — see the comment in
	// TestConcurrentRefreshTokenRedemptionOnlyOneSucceeds for why the ready
	// channel matters: it forces maximal contention instead of letting
	// goroutines mostly run one after another or trickle past an
	// already-closed channel.
	start := make(chan struct{})
	ready := make(chan struct{}, n)
	var wg sync.WaitGroup
	var successes int64
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			ready <- struct{}{}
			<-start
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
	for i := 0; i < n; i++ {
		<-ready
	}
	close(start)
	wg.Wait()

	assert.EqualValues(t, 1, successes,
		"exactly one of %d concurrent redemptions of the same authorization code must succeed", n)
}

// TestNegotiateScopeNilPrincipalDoesNotPanic guards negotiateScope's nil
// guard: handleAuthorize never calls it with a nil principal now that
// authentication runs first, but negotiateScope is called directly here
// rather than through the HTTP handler, so this pins the defensive check
// itself in case that invariant is ever violated by a future caller.
func TestNegotiateScopeNilPrincipalDoesNotPanic(t *testing.T) {
	assert.NotPanics(t, func() {
		scope, ok := negotiateScope(nil, "")
		assert.False(t, ok)
		assert.Empty(t, scope)
	})

	assert.NotPanics(t, func() {
		scope, ok := negotiateScope(nil, "paprika:read")
		assert.False(t, ok)
		assert.Empty(t, scope)
	})
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

// --- Fix round 2, Fold-in 3: unrecognised scope must be rejected, not
// silently dropped into an empty grant ---
//
// Before this fix, ParseScopes silently dropped any scope token it did not
// recognise, so a request for scope=admin (or a wrong-case
// scope=PAPRIKA:WRITE) sailed through /mcp/authorize with a 302 redirect and
// a "successful" code exchange, but the resulting access token carried an
// empty scope and could call nothing — a fail-safe but confusing outcome
// with no error to explain it. These requests must now be rejected outright
// with invalid_scope, the same way an unheld-but-recognised scope is.

func TestAuthorizeRejectsUnrecognisedScopeValue(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead, ScopeWrite)
	rec := authorizeForFix1(t, mux, redirect, bearer, "admin")

	assert.Equal(t, http.StatusBadRequest, rec.Code,
		"an unrecognised scope value must be rejected outright, not silently dropped into an empty grant")
	var oerr oauthError
	if rec.Code == http.StatusBadRequest {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
		assert.Equal(t, "invalid_scope", oerr.Error)
	}
}

func TestAuthorizeRejectsWrongCaseScopeValue(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead, ScopeWrite)
	rec := authorizeForFix1(t, mux, redirect, bearer, "PAPRIKA:WRITE")

	assert.Equal(t, http.StatusBadRequest, rec.Code,
		"scope matching must be exact; a wrong-case value must be rejected, not silently dropped")
	var oerr oauthError
	if rec.Code == http.StatusBadRequest {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
		assert.Equal(t, "invalid_scope", oerr.Error)
	}
}

// --- Consent flow: /mcp/authorize now authenticates as a CONSOLE user
// rather than requiring a pre-existing MCP token, and the scope granted
// comes from explicit consent (POST /mcp/authorize/consent) rather than a
// token claim a Google ID token could never carry. ---

// TestAuthorizeJSONGETUnauthenticatedStillReturns401 pins the non-browser
// half of the new behaviour: a JSON caller with no console credential gets
// exactly the same 401 it always did, never the new browser-only redirect to
// /mcp/consent.
func TestAuthorizeJSONGETUnauthenticatedStillReturns401(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil)
	req.Header.Set("Accept", "application/json")
	mux.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Empty(t, rec.Header().Get("Location"))
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "resource_metadata")
}

// TestAuthorizeBrowserGETWithNoCredentialRedirectsToConsent is the required
// browser-redirect test: an Accept: text/html GET with no console credential
// gets a 302 to /mcp/consent rather than the 401 a JSON caller gets. Fix
// round 1, Finding 1b changed what is forwarded: a registered redirect_uri
// gets the original query string preserved, verbatim, while an unregistered
// one gets ONLY "?error=invalid_request" — dropping every caller-supplied
// parameter, including the unregistered redirect_uri itself, so it is never
// reachable by an unauthenticated caller (see
// TestAuthorizeUnregisteredRedirectURIReachesConsentWithNoRedirectURI for
// that property in isolation).
//
// Critically, both responses must still be identical in STATUS and PATH —
// 302 to the exact same fixed /mcp/consent path — even though their query
// now legitimately differs: a third-party page driving this as a top-level
// navigation cannot read the Location header or the resulting cross-origin
// URL, and a cross-origin fetch of this endpoint gets an opaque response,
// so the differing query content is not an observable oracle the way a
// directly-inspectable JSON body would be. That is a deliberately narrower
// notion of "indistinguishable" than
// TestAuthorizeUnauthenticatedRequestsAreIndistinguishable's byte-identical
// JSON-path guarantee, which is unaffected by this change and still holds.
func TestAuthorizeBrowserGETWithNoCredentialRedirectsToConsent(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	registeredQuery := "client_id=test&response_type=code&code_challenge=abc&code_challenge_method=S256" +
		"&redirect_uri=" + url.QueryEscape(redirect)
	unregisteredQuery := "client_id=test&response_type=code&code_challenge=abc&code_challenge_method=S256" +
		"&redirect_uri=" + url.QueryEscape("https://evil.example/callback")

	get := func(query string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/mcp/authorize?"+query, nil)
		req.Header.Set("Accept", "text/html,application/xhtml+xml")
		mux.ServeHTTP(rec, req)
		return rec
	}

	registeredRec := get(registeredQuery)
	unregisteredRec := get(unregisteredQuery)

	require.Equal(t, http.StatusFound, registeredRec.Code)
	require.Equal(t, http.StatusFound, unregisteredRec.Code,
		"a browser probing an unregistered redirect_uri must get the same status and fixed path as a registered one")
	assert.Equal(t, "/mcp/consent?"+registeredQuery, registeredRec.Header().Get("Location"),
		"a registered client_id/redirect_uri gets the full original query forwarded")
	assert.Equal(t, "/mcp/consent?error=invalid_request", unregisteredRec.Header().Get("Location"),
		"an unregistered redirect_uri must never be forwarded to the browser-visible consent redirect")
}

// TestAuthorizeUnregisteredRedirectURIReachesConsentWithNoRedirectURI proves
// the required property in isolation: when client_id/redirect_uri fails
// registration on the browser path, the resulting Location's query has no
// redirect_uri parameter available to the consent page at all — not merely
// a different one.
func TestAuthorizeUnregisteredRedirectURIReachesConsentWithNoRedirectURI(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape("https://evil.example/callback"), nil)
	req.Header.Set("Accept", "text/html")
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "/mcp/consent", loc.Path)
	assert.Empty(t, loc.Query().Get("redirect_uri"),
		"the consent page must not receive any redirect_uri at all for an unregistered one")
	assert.Equal(t, "invalid_request", loc.Query().Get("error"))
}

// TestAuthorizeAuthenticatedBrowserGETIsRedirectedToConsent is Fix round 1,
// Finding 2's regression test: an already-authenticated browser caller must
// still go through the consent screen, never straight to a minted code —
// closing the consent-free grant path the finding identified. It uses an
// MCP-audience bearer (bearerFor) as the authenticated principal, standing
// in for any caller that manages to authenticate via
// authorizeAuthenticator, precisely because that authenticator accepts one
// in this test setup (see newTestServer's ConsoleAuthenticator comment) —
// the fix must not depend on which kind of credential authenticated.
func TestAuthorizeAuthenticatedBrowserGETIsRedirectedToConsent(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead, ScopeWrite)
	query := "client_id=test&response_type=code&code_challenge=" + pkceChallengeForFix1 +
		"&code_challenge_method=S256&redirect_uri=" + url.QueryEscape(redirect) + "&state=xyz"

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/mcp/authorize?"+query, nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusFound, rec.Code,
		"an authenticated browser caller must be redirected to consent, not given a code directly")
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "/mcp/consent", loc.Path)
	assert.Equal(t, redirect, loc.Query().Get("redirect_uri"),
		"a registered redirect_uri is still forwarded to consent for an authenticated browser caller")
	assert.Empty(t, loc.Query().Get("code"),
		"no authorization code may ever be minted for a browser caller without going through consent")
}

// TestConsentRequiresAuthentication proves POST /mcp/authorize/consent
// rejects a caller with no console credential.
func TestConsentRequiresAuthentication(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := postJSON(t, mux, "/mcp/authorize/consent", "", consentRequest{
		ClientID: "test", RedirectURI: redirect,
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{"paprika:read"},
	})
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// TestConsentRejectsUnregisteredRedirectURI proves the consent endpoint
// re-runs the exact-match redirect_uri check, and never sets a Location
// header on failure — the same fail-closed shape validateAuthorizeRequest
// already guarantees for GET.
func TestConsentRejectsUnregisteredRedirectURI(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: "https://evil.example/callback",
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{"paprika:read"},
	})

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, rec.Header().Get("Location"), "must never redirect to an unregistered URI")
	var oerr oauthError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
	assert.Equal(t, "invalid_request", oerr.Error)
}

// TestConsentGrantsOnlyTickedScopes is the central non-vacuous consent test:
// ticking only paprika:read must yield an access token carrying only
// paprika:read, never paprika:write. It is proven non-vacuous by also
// granting both scopes through the identical path and confirming THAT
// yields both — so the read-only result isn't just an authorize path that
// always returns an empty or fixed grant.
func TestConsentGrantsOnlyTickedScopes(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"

	grant := func(t *testing.T, scopes []string) string {
		t.Helper()
		srv := newTestServerWithRedirects(t, []string{redirect})
		mux := http.NewServeMux()
		srv.RegisterOAuthRoutes(mux)

		bearer := consoleBearerFor(t, "console-user")
		rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
			ClientID: "test", RedirectURI: redirect,
			CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
			Scopes: scopes,
		})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

		var body consentResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		dest, err := url.Parse(body.RedirectTo)
		require.NoError(t, err)
		code := dest.Query().Get("code")
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
		var tokenBody struct {
			AccessToken string `json:"access_token"`
		}
		require.NoError(t, json.Unmarshal(tokenResp.Body.Bytes(), &tokenBody))
		return tokenBody.AccessToken
	}

	readOnlyToken := grant(t, []string{"paprika:read"})
	bothToken := grant(t, []string{"paprika:read", "paprika:write"})

	mcpAuth := mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer)

	readOnlyPrincipal, err := mcpAuth.Authenticate(ctxWithBearer(readOnlyToken))
	require.NoError(t, err)
	assert.Equal(t, []string{"paprika:read"}, readOnlyPrincipal.Scopes,
		"ticking only read must not yield write")

	bothPrincipal, err := mcpAuth.Authenticate(ctxWithBearer(bothToken))
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"paprika:read", "paprika:write"}, bothPrincipal.Scopes,
		"ticking both scopes must yield both — proves the read-only grant above wasn't just a fixed/empty result")
}

// TestConsentRejectsUnrecognisedScope proves the consent endpoint rejects a
// ticked scope it does not recognise, the same fail-closed rule
// negotiateScope already enforces for the query-string authorize path.
func TestConsentRejectsUnrecognisedScope(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: redirect,
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{"admin"},
	})

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var oerr oauthError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
	assert.Equal(t, "invalid_scope", oerr.Error)
}

// TestConsentRejectsEmptyScopes proves ticking nothing is rejected rather
// than silently minting a token that can call nothing with no explanation.
func TestConsentRejectsEmptyScopes(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: redirect,
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{},
	})

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var oerr oauthError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
	assert.Equal(t, "invalid_scope", oerr.Error)
}

// TestConsentDenyRoundTripsThroughServer is Fix round 1, Finding 1a's
// central regression test: clicking Deny must route through the server,
// which validates client_id/redirect_uri exactly as on approve and returns
// a redirectTo IT built — carrying error=access_denied and the original
// state — rather than the UI ever constructing a navigation target itself
// from the raw, unvalidated redirect_uri. No code is minted on this path.
func TestConsentDenyRoundTripsThroughServer(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: redirect, State: "xyz123",
		Decision: "deny",
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body consentResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	dest, err := url.Parse(body.RedirectTo)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(dest.String(), redirect))
	assert.Equal(t, "access_denied", dest.Query().Get("error"))
	assert.Equal(t, "xyz123", dest.Query().Get("state"))
	assert.Empty(t, dest.Query().Get("code"), "a denial must never carry an authorization code")
}

// TestConsentDenyRejectsUnregisteredRedirectURI proves deny is validated
// exactly as strictly as approve: an attacker cannot use decision=deny as a
// side door to get the server to build a redirect to an unregistered URI.
func TestConsentDenyRejectsUnregisteredRedirectURI(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: "https://evil.example/callback", State: "xyz",
		Decision: "deny",
	})

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var oerr oauthError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
	assert.Equal(t, "invalid_request", oerr.Error)
}

// TestConsentRejectsUnrecognisedDecision proves an unrecognised decision
// value is rejected outright rather than silently falling through to
// either approve or deny.
func TestConsentRejectsUnrecognisedDecision(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := consoleBearerFor(t, "console-user")
	rec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID: "test", RedirectURI: redirect, State: "xyz",
		Decision: "maybe",
	})

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var oerr oauthError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
	assert.Equal(t, "invalid_request", oerr.Error)
}

// TestAuthorizeConsentTokenRoundTrip drives the FULL flow the design
// prescribes end to end: an unauthenticated browser GET to /mcp/authorize
// redirects to /mcp/consent preserving the query, the consent SPA (carrying
// the user's console session) POSTs the ticked scopes to
// /mcp/authorize/consent, and the resulting code exchanges at /mcp/token for
// an access token carrying the MCP audience and exactly the consented
// scope — never one derived from a token claim, since a console credential
// here carries no scope claim at all (consoleBearerFor mints one exactly
// like /auth/token does).
func TestAuthorizeConsentTokenRoundTrip(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	authorizeQuery := "client_id=test&response_type=code" +
		"&code_challenge=" + pkceChallengeForFix1 + "&code_challenge_method=S256" +
		"&redirect_uri=" + url.QueryEscape(redirect) + "&state=xyz&scope=paprika:read"

	getRec := httptest.NewRecorder()
	getReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/mcp/authorize?"+authorizeQuery, nil)
	getReq.Header.Set("Accept", "text/html")
	mux.ServeHTTP(getRec, getReq)
	require.Equal(t, http.StatusFound, getRec.Code)

	loc, err := url.Parse(getRec.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "/mcp/consent", loc.Path)

	bearer := consoleBearerFor(t, "console-user")
	consentRec := postJSON(t, mux, "/mcp/authorize/consent", bearer, consentRequest{
		ClientID:            loc.Query().Get("client_id"),
		RedirectURI:         loc.Query().Get("redirect_uri"),
		CodeChallenge:       loc.Query().Get("code_challenge"),
		CodeChallengeMethod: loc.Query().Get("code_challenge_method"),
		State:               loc.Query().Get("state"),
		Scopes:              []string{"paprika:read"},
	})
	require.Equal(t, http.StatusOK, consentRec.Code, consentRec.Body.String())

	var consentBody consentResponse
	require.NoError(t, json.Unmarshal(consentRec.Body.Bytes(), &consentBody))
	dest, err := url.Parse(consentBody.RedirectTo)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(dest.String(), redirect))
	assert.Equal(t, "xyz", dest.Query().Get("state"))
	code := dest.Query().Get("code")
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
	var tokenBody struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(tokenResp.Body.Bytes(), &tokenBody))

	mcpAuth := mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer)
	p, err := mcpAuth.Authenticate(ctxWithBearer(tokenBody.AccessToken))
	require.NoError(t, err)
	assert.Equal(t, "console-user", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)
}

func TestAuthorizeRejectsPartiallyUnrecognisedScopeMix(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	bearer := bearerFor(t, ScopeRead, ScopeWrite)
	// One recognised, held scope mixed with one bogus token: the whole
	// request must still be rejected rather than silently narrowed to just
	// the recognised one.
	rec := authorizeForFix1(t, mux, redirect, bearer, "paprika:read bogus")

	assert.Equal(t, http.StatusBadRequest, rec.Code,
		"a mix of a valid and an unrecognised scope token must be rejected in full")
	var oerr oauthError
	if rec.Code == http.StatusBadRequest {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &oerr))
		assert.Equal(t, "invalid_scope", oerr.Error)
	}
}
