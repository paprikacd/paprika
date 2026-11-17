package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testBrowserOrigin = "https://paprika.example.com"

func browserTestAuthenticator(t *testing.T, fixture *oidcProviderFixture) *OIDCAuthenticator {
	t.Helper()
	authenticator := newOIDCTestAuthenticator(t, fixture, fixture.trackedClient(time.Second))
	require.NoError(t, authenticator.EnableBrowserSessions([]byte("browser-session-test-secret")))
	return authenticator
}

func browserRequest(t *testing.T, handler http.HandlerFunc, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, testBrowserOrigin+path, strings.NewReader(body))
	request.Header.Set("Origin", testBrowserOrigin)
	request.Header.Set(browserSessionHeader, "1")
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	return response
}

func browserLogin(t *testing.T, authenticator *OIDCAuthenticator, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return browserRequest(t, authenticator.TokenHandler(), "/auth/token", `{"code":"code","codeVerifier":"verifier","redirectUri":"https://paprika.example.com/auth/callback"}`, cookie)
}

func responseCookie(t *testing.T, response *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	cookies := response.Result().Cookies()
	require.Len(t, cookies, 1)
	return cookies[0]
}

func TestBrowserSessionLifecycleAndFixedExpiry(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	idToken := fixture.signIDToken(t)
	var refreshCount atomic.Int64
	fixture.tokenHandler = func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, testOIDCClientID, r.Form.Get("client_id"))
		assert.Equal(t, testOIDCClientSecret, r.Form.Get("client_secret"))
		refreshToken := "provider-refresh-original"
		if r.Form.Get("grant_type") == "refresh_token" {
			refreshCount.Add(1)
			assert.Equal(t, "provider-refresh-original", r.Form.Get("refresh_token"))
			refreshToken = "provider-refresh-rotated"
		}
		writeJSON(t, w, map[string]interface{}{"id_token": idToken, "refresh_token": refreshToken, "expires_in": 3600, "token_type": "Bearer"})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	now := time.Now().Truncate(time.Second)
	authenticator.sessions.now = func() time.Time { return now }
	login := browserLogin(t, authenticator, nil)
	require.Equal(t, http.StatusOK, login.Code)
	assert.NotContains(t, login.Body.String(), "provider-refresh")
	assert.NotContains(t, login.Body.String(), `"refreshToken"`)
	var loginBody TokenResponse
	require.NoError(t, json.Unmarshal(login.Body.Bytes(), &loginBody))
	assert.True(t, loginBody.SessionRefreshAvailable)
	cookie := responseCookie(t, login)
	assert.True(t, cookie.HttpOnly)
	assert.True(t, cookie.Secure)
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
	assert.Equal(t, "/auth", cookie.Path)
	assert.Empty(t, cookie.Domain)
	assert.Equal(t, int(browserSessionTTL.Seconds()), cookie.MaxAge)
	assert.WithinDuration(t, now.Add(browserSessionTTL), cookie.Expires, time.Second)
	assert.NotContains(t, cookie.Value, "provider-refresh")

	now = now.Add(time.Hour)
	refresh := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
	require.Equal(t, http.StatusOK, refresh.Code)
	rotated := responseCookie(t, refresh)
	assert.Equal(t, cookie.Expires, rotated.Expires, "renewal must never extend the session deadline")
	assert.Equal(t, cookie.MaxAge-3600, rotated.MaxAge)
	assert.NotEqual(t, cookie.Value, rotated.Value)
	assert.NotContains(t, refresh.Body.String(), "provider-refresh")
	var refreshed TokenResponse
	require.NoError(t, json.Unmarshal(refresh.Body.Bytes(), &refreshed))
	assert.Equal(t, idToken, refreshed.IDToken)
	assert.True(t, refreshed.SessionRefreshAvailable)
	assert.Positive(t, refreshed.ExpiresIn)
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/auth/refresh", http.NoBody)
	request.AddCookie(rotated)
	session, err := authenticator.readBrowserSession(request)
	require.NoError(t, err)
	assert.Equal(t, "provider-refresh-rotated", session.RefreshToken)
	assert.EqualValues(t, 1, refreshCount.Load())

	logout := browserRequest(t, authenticator.LogoutHandler(), "/auth/logout", "", rotated)
	assert.Equal(t, http.StatusNoContent, logout.Code)
	assert.Empty(t, logout.Body.String())
	assert.Equal(t, -1, responseCookie(t, logout).MaxAge)
	assert.True(t, responseCookie(t, logout).Secure)
}

func TestBrowserSessionsAreBoundToOriginAndBrowserCallback(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	var providerCalls atomic.Int64
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		providerCalls.Add(1)
		writeJSON(t, w, map[string]interface{}{"id_token": fixture.signIDToken(t), "refresh_token": "private-refresh"})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	for _, path := range []string{"/auth/refresh", "/auth/logout", "/auth/token"} {
		for _, origin := range []string{"", "null", "https://attacker.example", testBrowserOrigin + "/", "http://paprika.example.com"} {
			t.Run(path+origin, func(t *testing.T) {
				request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(`{"code":"code","codeVerifier":"verifier"}`))
				request.Header.Set("Origin", origin)
				request.Header.Set(browserSessionHeader, "1")
				response := httptest.NewRecorder()
				handler := authenticator.RefreshHandler()
				if path == "/auth/logout" {
					handler = authenticator.LogoutHandler()
				}
				if path == "/auth/token" {
					handler = authenticator.TokenHandler()
				}
				handler(response, request)
				assert.Equal(t, http.StatusForbidden, response.Code)
				assert.Empty(t, response.Header().Values("Set-Cookie"), "untrusted origins cannot clear another session")
			})
		}
	}
	for _, handler := range []http.HandlerFunc{authenticator.RefreshHandler(), authenticator.LogoutHandler()} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/auth/refresh", http.NoBody)
		request.Header.Set("Origin", testBrowserOrigin)
		response := httptest.NewRecorder()
		handler(response, request)
		assert.Equal(t, http.StatusForbidden, response.Code)
	}
	assert.Zero(t, providerCalls.Load())
	cli := performTokenRequest(t, authenticator, TokenRequest{Code: "code", CodeVerifier: "verifier", RedirectURI: CLIRedirectURL})
	require.Equal(t, http.StatusOK, cli.Code)
	assert.Empty(t, cli.Header().Values("Set-Cookie"))
	assert.NotContains(t, cli.Body.String(), "private-refresh")
	var cliToken TokenResponse
	require.NoError(t, json.Unmarshal(cli.Body.Bytes(), &cliToken))
	assert.False(t, cliToken.SessionRefreshAvailable)
}

func TestBrowserSessionInvalidCookiesNeverReachProvider(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	var calls atomic.Int64
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, map[string]interface{}{"id_token": fixture.signIDToken(t), "refresh_token": "refresh"})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	cookie := responseCookie(t, browserLogin(t, authenticator, nil))
	initialCalls := calls.Load()
	for _, value := range []string{"", "not-a-cookie", cookie.Value[:20], cookie.Value[:20] + "wrong" + cookie.Value[25:], strings.Repeat("x", maxSessionCookieSize+1)} {
		// #nosec G124 -- Copy the issued cookie's secure attributes; this corrupted value is added only to an in-memory request, never a Set-Cookie response.
		invalidCookie := *cookie
		invalidCookie.Value = value
		response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", &invalidCookie)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
		assert.Equal(t, -1, responseCookie(t, response).MaxAge)
	}
	t.Run("expired", func(t *testing.T) {
		authenticator.sessions.now = func() time.Time { return time.Now().Add(browserSessionTTL + time.Minute) }
		response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
	})
	t.Run("changed secret", func(t *testing.T) {
		require.NoError(t, authenticator.EnableBrowserSessions([]byte("different-secret")))
		response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
	})
	t.Run("different client", func(t *testing.T) {
		authenticator.oauth2Config.ClientID = "different-client"
		require.NoError(t, authenticator.EnableBrowserSessions([]byte("browser-session-test-secret")))
		response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
	})
	assert.Equal(t, initialCalls, calls.Load())
}

func TestBrowserRefreshFailuresAndIdentityValidation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		claims   map[string]interface{}
		expected int
	}{
		{name: "revoked", status: 400, body: `{"error":"invalid_grant","error_description":"provider-secret"}`, expected: 401},
		{name: "provider outage", status: 503, body: `{"error":"invalid_grant"}`, expected: 503},
		{name: "rate limited", status: 429, body: "provider-secret", expected: 503},
		{name: "client configuration", status: 401, body: `{"error":"invalid_client"}`, expected: 503},
		{name: "bad response", status: 200, body: "provider-secret", expected: 503},
		{name: "missing id token", status: 200, body: `{"access_token":"provider-secret"}`, expected: 401},
		{name: "invalid id token", status: 200, body: `{"id_token":"provider-secret"}`, expected: 503},
		{name: "changed subject", claims: map[string]interface{}{"sub": "another-user"}, expected: 401},
		{name: "changed audience", claims: map[string]interface{}{"aud": []string{testOIDCClientID, "another-client"}}, expected: 401},
		{name: "changed issuer", claims: map[string]interface{}{"iss": "https://untrusted.example"}, expected: 503},
		{name: "expired token", claims: map[string]interface{}{"exp": time.Now().Add(-time.Hour).Unix()}, expected: 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newOIDCProviderFixture(t)
			initial := fixture.signIDToken(t)
			replacement := ""
			if tc.claims != nil {
				replacement = fixture.signIDTokenClaims(t, tc.claims)
			}
			fixture.tokenHandler = func(w http.ResponseWriter, r *http.Request) {
				require.NoError(t, r.ParseForm())
				if r.Form.Get("grant_type") == "authorization_code" {
					writeJSON(t, w, map[string]interface{}{"id_token": initial, "refresh_token": "private-refresh"})
					return
				}
				if replacement != "" {
					writeJSON(t, w, map[string]interface{}{"id_token": replacement})
					return
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}
			authenticator := browserTestAuthenticator(t, fixture)
			cookie := responseCookie(t, browserLogin(t, authenticator, nil))
			response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
			assert.Equal(t, tc.expected, response.Code)
			assert.NotContains(t, response.Body.String(), "provider-secret")
			assert.NotContains(t, response.Body.String(), "private-refresh")
			assert.NotContains(t, response.Body.String(), `"idToken"`)
			if tc.expected == 401 {
				assert.Equal(t, -1, responseCookie(t, response).MaxAge)
			} else {
				assert.Empty(t, response.Header().Values("Set-Cookie"))
			}
		})
	}
}

func TestBrowserRefreshTransportFailureRetainsCookie(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]interface{}{"id_token": fixture.signIDToken(t), "refresh_token": "refresh"})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	cookie := responseCookie(t, browserLogin(t, authenticator, nil))
	authenticator.httpClient = &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) { return nil, errors.New("private transport details") })}
	response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", cookie)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Empty(t, response.Header().Values("Set-Cookie"))
	assert.NotContains(t, response.Body.String(), "private")
}

func TestBrowserRefreshJWKSOutageRetainsGrantWithoutReturningToken(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	idToken := fixture.signIDToken(t)
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]interface{}{"id_token": idToken, "refresh_token": "refresh"})
	}
	original := browserTestAuthenticator(t, fixture)
	cookie := responseCookie(t, browserLogin(t, original, nil))
	base := fixture.server.Client().Transport
	client := &http.Client{Timeout: time.Second, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/jwks" {
			return nil, errors.New("private JWKS outage details")
		}
		return base.RoundTrip(request)
	})}
	// A second replica has no cached signing key, but can decrypt the cookie.
	replica := newOIDCTestAuthenticator(t, fixture, client)
	require.NoError(t, replica.EnableBrowserSessions([]byte("browser-session-test-secret")))
	response := browserRequest(t, replica.RefreshHandler(), "/auth/refresh", "", cookie)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Empty(t, response.Header().Values("Set-Cookie"))
	assert.NotContains(t, response.Body.String(), idToken)
	assert.NotContains(t, response.Body.String(), "private")
	assert.NotContains(t, response.Body.String(), `"idToken"`)
}

func TestBrowserRefreshRejectsVerifiedIssuerMismatch(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]interface{}{"id_token": fixture.signIDToken(t), "refresh_token": "refresh"})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	cookie := responseCookie(t, browserLogin(t, authenticator, nil))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/auth/refresh", http.NoBody)
	request.AddCookie(cookie)
	session, err := authenticator.readBrowserSession(request)
	require.NoError(t, err)
	session.Issuer = "https://another-original-issuer.example"
	sealed := httptest.NewRecorder()
	require.NoError(t, authenticator.writeBrowserSession(sealed, session))
	response := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", responseCookie(t, sealed))
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.Equal(t, -1, responseCookie(t, response).MaxAge)
}

func TestBrowserLoginWithoutNewRefreshPreservesOnlySameIdentity(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	var calls atomic.Int64
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		count := calls.Add(1)
		claims := map[string]interface{}{}
		if count == 3 {
			claims["sub"] = "another-user"
		}
		response := map[string]interface{}{"id_token": fixture.signIDTokenClaims(t, claims)}
		if count == 1 {
			response["refresh_token"] = "private-refresh"
		}
		writeJSON(t, w, response)
	}
	authenticator := browserTestAuthenticator(t, fixture)
	cookie := responseCookie(t, browserLogin(t, authenticator, nil))
	for _, sameUser := range []bool{true, false} {
		response := browserLogin(t, authenticator, cookie)
		assert.Equal(t, 200, response.Code)
		var token TokenResponse
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &token))
		assert.Equal(t, sameUser, token.SessionRefreshAvailable)
		if sameUser {
			assert.Empty(t, response.Header().Values("Set-Cookie"))
		} else {
			assert.Equal(t, -1, responseCookie(t, response).MaxAge)
		}
	}
}

func TestBrowserLoginGoogleAccountHintsAndConsent(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	authenticator := browserTestAuthenticator(t, fixture)
	authenticator.issuer = "https://accounts.google.com"
	fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]interface{}{"id_token": fixture.signIDToken(t), "refresh_token": "refresh"})
	}
	cookie := responseCookie(t, browserLogin(t, authenticator, nil))
	for _, tc := range []struct {
		name, query, prompt, hint string
		cookie                    *http.Cookie
		offline                   bool
	}{
		{name: "first grant", query: "login_hint=user%40example.com", prompt: "consent", hint: "user@example.com", offline: true},
		{name: "returning account", query: "login_hint=user%40example.com", hint: "user@example.com", cookie: cookie, offline: true},
		{name: "switch", query: "switchAccount=true&login_hint=user%40example.com", prompt: "select_account consent", cookie: cookie, offline: true},
		{name: "CLI", query: "redirect_uri=" + url.QueryEscape(CLIRedirectURL) + "&login_hint=user%40example.com&switchAccount=true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/login?"+tc.query, http.NoBody)
			if tc.cookie != nil {
				request.AddCookie(tc.cookie)
			}
			response := httptest.NewRecorder()
			authenticator.LoginHandler()(response, request)
			require.Equal(t, 200, response.Code)
			assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			var login LoginResponse
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &login))
			authorize, err := url.Parse(login.URL)
			require.NoError(t, err)
			assert.Equal(t, tc.prompt, authorize.Query().Get("prompt"))
			assert.Equal(t, tc.hint, authorize.Query().Get("login_hint"))
			assert.Equal(t, tc.offline, authorize.Query().Get("access_type") == "offline")
			assert.NotEmpty(t, authorize.Query().Get("code_challenge"))
		})
	}
}

func TestBrowserSessionConfigurationAndBounds(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	for _, callback := range []string{"https://paprika.example.com/auth/callback", "http://localhost:3015/auth/callback", "http://127.0.0.1:3015/auth/callback", "http://[::1]:3015/auth/callback"} {
		authenticator := newOIDCTestAuthenticator(t, fixture, nil)
		authenticator.oauth2Config.RedirectURL = callback
		require.NoError(t, authenticator.EnableBrowserSessions([]byte("secret")))
		assert.Equal(t, strings.HasPrefix(callback, "https:"), authenticator.sessions.secure)
	}
	for _, callback := range []string{"http://public.example/auth/callback", "https://user:password@paprika.example/auth/callback", "https://paprika.example/auth/callback?query=value", "file:///auth/callback"} {
		authenticator := newOIDCTestAuthenticator(t, fixture, nil)
		authenticator.oauth2Config.RedirectURL = callback
		require.Error(t, authenticator.EnableBrowserSessions([]byte("secret")))
	}
	authenticator := newOIDCTestAuthenticator(t, fixture, nil)
	require.NoError(t, authenticator.EnableBrowserSessions(nil))
	assert.Nil(t, authenticator.sessions)
	for _, enabled := range []bool{false, true} {
		if enabled {
			require.NoError(t, authenticator.EnableBrowserSessions([]byte("secret")))
		}
		response := httptest.NewRecorder()
		PublicConfigHandler(Config{Enabled: true, TokenSecret: []byte("secret")}, authenticator)(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/config", http.NoBody))
		var config struct {
			Basic   struct{ Enabled bool }
			Session struct{ RefreshEnabled bool }
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &config))
		assert.False(t, config.Basic.Enabled)
		assert.Equal(t, enabled, config.Session.RefreshEnabled)
		assert.NotContains(t, response.Body.String(), "secret")
	}
	for _, handler := range []http.HandlerFunc{authenticator.RefreshHandler(), authenticator.LogoutHandler()} {
		response := browserRequest(t, handler, "/auth/refresh", strings.Repeat("x", 1025), nil)
		assert.Equal(t, 400, response.Code)
		response = httptest.NewRecorder()
		handler(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/refresh", http.NoBody))
		assert.Equal(t, 405, response.Code)
	}
	response := browserRequest(t, authenticator.TokenHandler(), "/auth/token", `{"code":"`+strings.Repeat("x", maxAuthRequestSize)+`","codeVerifier":"verifier"}`, nil)
	assert.Equal(t, 400, response.Code)
}

func TestBrowserSessionConcurrentRefreshHasNoSharedIdentityState(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	first := fixture.signIDTokenClaims(t, map[string]interface{}{"sub": "first-user"})
	second := fixture.signIDTokenClaims(t, map[string]interface{}{"sub": "second-user"})
	fixture.tokenHandler = func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		identity := r.Form.Get("code")
		if identity == "" {
			identity = r.Form.Get("refresh_token")
		}
		token := first
		if identity == "second" {
			token = second
		}
		writeJSON(t, w, map[string]interface{}{"id_token": token, "refresh_token": identity})
	}
	authenticator := browserTestAuthenticator(t, fixture)
	var wg sync.WaitGroup
	for _, identity := range []string{"first", "second"} {
		wg.Go(func() {
			login := browserRequest(t, authenticator.TokenHandler(), "/auth/token", `{"code":"`+identity+`","codeVerifier":"verifier"}`, nil)
			require.Equal(t, 200, login.Code)
			refresh := browserRequest(t, authenticator.RefreshHandler(), "/auth/refresh", "", responseCookie(t, login))
			assert.Equal(t, 200, refresh.Code)
			var token TokenResponse
			require.NoError(t, json.Unmarshal(refresh.Body.Bytes(), &token))
			verified, err := authenticator.verifier.Verify(t.Context(), token.IDToken)
			require.NoError(t, err)
			assert.Equal(t, identity+"-user", verified.Subject)
		})
	}
	wg.Wait()
}
