package auth

import (
	"context"
	"crypto"
	cryptorand "crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestOIDCRedirectValidation(t *testing.T) {
	const configuredRedirect = "https://paprika.example.com/auth/callback"

	var tokenRequests atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenRequests.Add(1)
		http.Error(w, "provider request should not have happened", http.StatusBadGateway)
	}))
	t.Cleanup(provider.Close)

	authenticator := &OIDCAuthenticator{oauth2Config: oauth2.Config{
		ClientID:     "client-id",
		ClientSecret: "client-secret-marker",
		RedirectURL:  configuredRedirect,
		Endpoint: oauth2.Endpoint{
			AuthURL:  provider.URL + "/authorize",
			TokenURL: provider.URL + "/token",
		},
	}}

	t.Run("login accepts exact UI and CLI redirects", func(t *testing.T) {
		for _, redirectURI := range []string{configuredRedirect, "http://127.0.0.1:17632/callback"} {
			t.Run(redirectURI, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, "/auth/login?redirect_uri="+url.QueryEscape(redirectURI), http.NoBody)
				resp := httptest.NewRecorder()

				authenticator.LoginHandler().ServeHTTP(resp, req)

				require.Equal(t, http.StatusOK, resp.Code)
				var login LoginResponse
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&login))
				authURL, err := url.Parse(login.URL)
				require.NoError(t, err)
				assert.Equal(t, redirectURI, authURL.Query().Get("redirect_uri"))
			})
		}
	})

	t.Run("login defaults omitted redirect to configured UI", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/login", http.NoBody)
		resp := httptest.NewRecorder()

		authenticator.LoginHandler().ServeHTTP(resp, req)

		require.Equal(t, http.StatusOK, resp.Code)
		var login LoginResponse
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&login))
		authURL, err := url.Parse(login.URL)
		require.NoError(t, err)
		assert.Equal(t, configuredRedirect, authURL.Query().Get("redirect_uri"))
	})

	invalidRedirects := []string{
		"https://127.0.0.1:17632/callback",
		"http://localhost:17632/callback",
		"http://127.0.0.1:17633/callback",
		"http://127.0.0.1:17632/wrong",
		"http://127.0.0.1:17632/callback?extra=true",
		configuredRedirect + "?extra=true",
	}
	for _, redirectURI := range invalidRedirects {
		t.Run("login rejects "+redirectURI, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/login?redirect_uri="+url.QueryEscape(redirectURI), http.NoBody)
			resp := httptest.NewRecorder()

			authenticator.LoginHandler().ServeHTTP(resp, req)

			assert.Equal(t, http.StatusBadRequest, resp.Code)
		})

		t.Run("token rejects "+redirectURI, func(t *testing.T) {
			body := fmt.Sprintf(`{"code":"code-marker","codeVerifier":"verifier-marker","redirectUri":%q}`, redirectURI)
			req := httptest.NewRequest(http.MethodPost, "/auth/token", strings.NewReader(body))
			resp := httptest.NewRecorder()

			authenticator.TokenHandler().ServeHTTP(resp, req)

			assert.Equal(t, http.StatusBadRequest, resp.Code)
		})
	}
	assert.Zero(t, tokenRequests.Load(), "invalid redirects must be rejected before a provider request")
}

func TestOIDCRedirectValidationRejectsOmittedRedirectWithoutConfiguration(t *testing.T) {
	var tokenRequests atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenRequests.Add(1)
		http.Error(w, "provider request should not have happened", http.StatusBadGateway)
	}))
	t.Cleanup(provider.Close)

	authenticator := &OIDCAuthenticator{oauth2Config: oauth2.Config{
		ClientID: "client-id",
		Endpoint: oauth2.Endpoint{
			AuthURL:  provider.URL + "/authorize",
			TokenURL: provider.URL + "/token",
		},
	}}

	loginReq := httptest.NewRequest(http.MethodGet, "/auth/login", http.NoBody)
	loginResp := httptest.NewRecorder()
	authenticator.LoginHandler().ServeHTTP(loginResp, loginReq)
	assert.Equal(t, http.StatusBadRequest, loginResp.Code)

	tokenReq := httptest.NewRequest(http.MethodPost, "/auth/token", strings.NewReader(
		`{"code":"code-marker","codeVerifier":"verifier-marker"}`,
	))
	tokenResp := httptest.NewRecorder()
	authenticator.TokenHandler().ServeHTTP(tokenResp, tokenReq)
	assert.Equal(t, http.StatusBadRequest, tokenResp.Code)
	assert.Zero(t, tokenRequests.Load(), "an omitted invalid redirect must not reach the provider")
}

const (
	testOIDCClientID       = "oidc-client-id"
	testOIDCClientSecret   = "client-secret-marker"
	testOIDCCode           = "authorization-code-marker"
	testOIDCVerifier       = "code-verifier-marker"
	testOIDCAccessToken    = "access-token-marker"
	testOIDCInvalidIDToken = "id-token-marker"
	testOIDCProviderBody   = "provider-body-marker"
	testOIDCTransportError = "transport-error-marker"
)

func TestOIDCTokenExchangeAcceptsAllowedRedirectsAndValidatesIDToken(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	validIDToken := fixture.signIDToken(t)
	var redirectsMu sync.Mutex
	var redirects []string
	fixture.tokenHandler = func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, testOIDCCode, r.Form.Get("code"))
		assert.Equal(t, testOIDCVerifier, r.Form.Get("code_verifier"))
		assert.Equal(t, testOIDCClientSecret, r.Form.Get("client_secret"))
		redirectsMu.Lock()
		redirects = append(redirects, r.Form.Get("redirect_uri"))
		redirectsMu.Unlock()
		writeJSON(t, w, map[string]interface{}{
			"access_token": testOIDCAccessToken,
			"token_type":   "Bearer",
			"expires_in":   3600,
			"id_token":     validIDToken,
		})
	}

	tracker := &trackingTransport{base: fixture.server.Client().Transport}
	client := &http.Client{Transport: tracker, Timeout: time.Second}
	authenticator := newOIDCTestAuthenticator(t, fixture, client)

	for _, tc := range []struct {
		name        string
		redirectURI string
		expected    string
	}{
		{name: "configured UI", redirectURI: "https://paprika.example.com/auth/callback", expected: "https://paprika.example.com/auth/callback"},
		{name: "fixed CLI", redirectURI: "http://127.0.0.1:17632/callback", expected: "http://127.0.0.1:17632/callback"},
		{name: "omitted defaults to UI", expected: "https://paprika.example.com/auth/callback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := performTokenRequest(t, authenticator, TokenRequest{
				Code:         testOIDCCode,
				CodeVerifier: testOIDCVerifier,
				RedirectURI:  tc.redirectURI,
			})

			require.Equal(t, http.StatusOK, resp.Code)
			var token TokenResponse
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&token))
			assert.Equal(t, validIDToken, token.IDToken)
			assert.Equal(t, testOIDCAccessToken, token.AccessToken)
		})
	}

	redirectsMu.Lock()
	assert.Equal(t, []string{
		"https://paprika.example.com/auth/callback",
		"http://127.0.0.1:17632/callback",
		"https://paprika.example.com/auth/callback",
	}, redirects)
	redirectsMu.Unlock()
	assert.GreaterOrEqual(t, tracker.callsFor("/.well-known/openid-configuration"), 1)
	assert.GreaterOrEqual(t, tracker.callsFor("/jwks"), 1, "ID token validation must use the injected client")
	assert.Equal(t, 3, tracker.callsFor("/token"), "token exchanges must use the injected client")
	tracker.requireAllBodiesClosed(t)
}

func TestOIDCTokenExchangeUsesBoundedDefaultHTTPClient(t *testing.T) {
	fixture := newOIDCProviderFixture(t)
	authenticator := newOIDCTestAuthenticator(t, fixture, nil)

	require.NotNil(t, authenticator.httpClient)
	assert.NotSame(t, http.DefaultClient, authenticator.httpClient)
	assert.Equal(t, oidcHTTPTimeout, authenticator.httpClient.Timeout)
}

func TestOIDCTokenExchangeFailuresAreBoundedClosedAndSanitized(t *testing.T) {
	tests := []struct {
		name          string
		configure     func(t *testing.T, fixture *oidcProviderFixture) *http.Client
		expectedError string
	}{
		{
			name: "timeout during response body",
			configure: func(t *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					_, err := io.WriteString(w, `{"access_token":"`)
					require.NoError(t, err)
					if flusher, ok := w.(http.Flusher); ok {
						flusher.Flush()
					}
					<-r.Context().Done()
				}
				return &http.Client{
					Transport: &trackingTransport{base: fixture.server.Client().Transport},
					Timeout:   25 * time.Millisecond,
				}
			},
			expectedError: "token request failed",
		},
		{
			name: "transport error",
			configure: func(_ *testing.T, fixture *oidcProviderFixture) *http.Client {
				base := fixture.server.Client().Transport
				transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
					if req.URL.Path == "/token" {
						return nil, errors.New(testOIDCTransportError)
					}
					return base.RoundTrip(req)
				})
				return &http.Client{Transport: &trackingTransport{base: transport}, Timeout: time.Second}
			},
			expectedError: "token request failed",
		},
		{
			name: "non-200 response",
			configure: func(_ *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
					http.Error(w, testOIDCProviderBody, http.StatusTeapot)
				}
				return fixture.trackedClient(time.Second)
			},
			expectedError: "token endpoint returned HTTP 418",
		},
		{
			name: "oversized response",
			configure: func(_ *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
					_, _ = io.WriteString(w, strings.Repeat(testOIDCProviderBody, maxTokenResponseSize/len(testOIDCProviderBody)+2))
				}
				return fixture.trackedClient(time.Second)
			},
			expectedError: "token endpoint response too large",
		},
		{
			name: "malformed JSON response",
			configure: func(_ *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
					_, _ = io.WriteString(w, "{"+testOIDCProviderBody)
				}
				return fixture.trackedClient(time.Second)
			},
			expectedError: "invalid token endpoint response",
		},
		{
			name: "missing ID token",
			configure: func(t *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
					writeJSON(t, w, map[string]interface{}{"access_token": testOIDCAccessToken})
				}
				return fixture.trackedClient(time.Second)
			},
			expectedError: "no id_token in response",
		},
		{
			name: "invalid ID token",
			configure: func(t *testing.T, fixture *oidcProviderFixture) *http.Client {
				fixture.tokenHandler = func(w http.ResponseWriter, _ *http.Request) {
					writeJSON(t, w, map[string]interface{}{
						"access_token": testOIDCAccessToken,
						"id_token":     testOIDCInvalidIDToken,
					})
				}
				return fixture.trackedClient(time.Second)
			},
			expectedError: "id_token validation failed",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newOIDCProviderFixture(t)
			client := tc.configure(t, fixture)
			authenticator := newOIDCTestAuthenticator(t, fixture, client)
			tokenReq := &TokenRequest{
				Code:         testOIDCCode,
				CodeVerifier: testOIDCVerifier,
				RedirectURI:  CLIRedirectURL,
			}

			_, _, err := authenticator.exchangeAndValidate(context.Background(), tokenReq)
			require.EqualError(t, err, tc.expectedError)
			assertNoOIDCSecrets(t, err.Error())

			resp := performTokenRequest(t, authenticator, *tokenReq)
			assert.Equal(t, http.StatusUnauthorized, resp.Code)
			assert.Equal(t, tc.expectedError+"\n", resp.Body.String())
			assertNoOIDCSecrets(t, resp.Body.String())

			if tracker, ok := client.Transport.(*trackingTransport); ok {
				tracker.requireAllBodiesClosed(t)
			}
		})
	}
}

type oidcProviderFixture struct {
	server       *httptest.Server
	signingKey   *rsa.PrivateKey
	tokenHandler http.HandlerFunc
}

func newOIDCProviderFixture(t *testing.T) *oidcProviderFixture {
	t.Helper()
	signingKey, err := rsa.GenerateKey(cryptorand.Reader, 2048)
	require.NoError(t, err)

	fixture := &oidcProviderFixture{signingKey: signingKey}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			writeJSON(t, w, map[string]interface{}{
				"issuer":                                fixture.server.URL,
				"authorization_endpoint":                fixture.server.URL + "/authorize",
				"token_endpoint":                        fixture.server.URL + "/token",
				"jwks_uri":                              fixture.server.URL + "/jwks",
				"response_types_supported":              []string{"code"},
				"subject_types_supported":               []string{"public"},
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/jwks":
			publicKey := fixture.signingKey.PublicKey
			writeJSON(t, w, map[string]interface{}{"keys": []map[string]string{{
				"kty": "RSA",
				"kid": "test-key",
				"use": "sig",
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			}}})
		case "/token":
			if fixture.tokenHandler == nil {
				http.Error(w, "token handler not configured", http.StatusInternalServerError)
				return
			}
			fixture.tokenHandler(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *oidcProviderFixture) signIDToken(t *testing.T) string {
	t.Helper()
	header, err := json.Marshal(map[string]interface{}{"alg": "RS256", "kid": "test-key", "typ": "JWT"})
	require.NoError(t, err)
	claims, err := json.Marshal(map[string]interface{}{
		"iss": f.server.URL,
		"sub": "test-user",
		"aud": testOIDCClientID,
		"iat": time.Now().Add(-time.Minute).Unix(),
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	require.NoError(t, err)

	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := crypto.SHA256.New()
	_, err = digest.Write([]byte(unsigned))
	require.NoError(t, err)
	signature, err := rsa.SignPKCS1v15(cryptorand.Reader, f.signingKey, crypto.SHA256, digest.Sum(nil))
	require.NoError(t, err)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (f *oidcProviderFixture) trackedClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &trackingTransport{base: f.server.Client().Transport},
		Timeout:   timeout,
	}
}

func newOIDCTestAuthenticator(t *testing.T, fixture *oidcProviderFixture, client *http.Client) *OIDCAuthenticator {
	t.Helper()
	authenticator, err := NewOIDCAuthenticator(context.Background(), &OIDCConfig{
		IssuerURL:    fixture.server.URL,
		ClientID:     testOIDCClientID,
		ClientSecret: testOIDCClientSecret,
		RedirectURL:  "https://paprika.example.com/auth/callback",
		HTTPClient:   client,
	})
	require.NoError(t, err)
	return authenticator
}

func performTokenRequest(t *testing.T, authenticator *OIDCAuthenticator, tokenReq TokenRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(tokenReq)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/auth/token", strings.NewReader(string(body)))
	resp := httptest.NewRecorder()
	authenticator.TokenHandler().ServeHTTP(resp, req)
	return resp
}

func writeJSON(t *testing.T, w http.ResponseWriter, value interface{}) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	require.NoError(t, json.NewEncoder(w).Encode(value))
}

func assertNoOIDCSecrets(t *testing.T, value string) {
	t.Helper()
	for _, marker := range []string{
		testOIDCCode,
		testOIDCVerifier,
		testOIDCClientSecret,
		testOIDCAccessToken,
		testOIDCInvalidIDToken,
		testOIDCProviderBody,
		testOIDCTransportError,
	} {
		assert.NotContains(t, value, marker)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type trackingTransport struct {
	base http.RoundTripper
	mu   sync.Mutex
	path map[string]int
	body []*trackingBody
}

func (t *trackingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.path == nil {
		t.path = make(map[string]int)
	}
	t.path[req.URL.Path]++
	if resp != nil && resp.Body != nil {
		body := &trackingBody{ReadCloser: resp.Body}
		t.body = append(t.body, body)
		resp.Body = body
	}
	return resp, err
}

func (t *trackingTransport) callsFor(path string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.path[path]
}

func (t *trackingTransport) requireAllBodiesClosed(testingT *testing.T) {
	testingT.Helper()
	t.mu.Lock()
	defer t.mu.Unlock()
	require.NotEmpty(testingT, t.body)
	for _, body := range t.body {
		assert.True(testingT, body.closed.Load(), "response body was not closed")
	}
}

type trackingBody struct {
	io.ReadCloser
	closed atomic.Bool
}

func (b *trackingBody) Close() error {
	b.closed.Store(true)
	return b.ReadCloser.Close()
}

const (
	testPassword = "secret"
	testUsername = "admin"
	testNS       = "default"
)

func TestPrincipal_IsInGroup(t *testing.T) {
	t.Parallel()
	p := &Principal{Groups: []string{"admin", "dev"}}
	assert.True(t, p.IsInGroup("admin"))
	assert.False(t, p.IsInGroup("ops"))
}

func TestPrincipal_HasScope(t *testing.T) {
	t.Parallel()
	p := &Principal{Claims: map[string]interface{}{
		"role":  "admin",
		"roles": []interface{}{"read", "write"},
	}}
	assert.True(t, p.HasScope("role", "admin"))
	assert.True(t, p.HasScope("roles", "write"))
	assert.False(t, p.HasScope("role", "user"))
}

func TestPrincipalContext(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	assert.Nil(t, PrincipalFromContext(ctx))

	p := &Principal{Subject: "user-1"}
	ctx = WithPrincipal(ctx, p)
	assert.Equal(t, p, PrincipalFromContext(ctx))
}

func TestBasicAuthenticator(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	authn, err := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: string(ph),
	})
	require.NoError(t, err)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	require.NoError(t, err)
	req.SetBasicAuth(testUsername, testPassword)

	ctx := WithRequest(context.Background(), req)
	p, err := authn.Authenticate(ctx)
	require.NoError(t, err)
	assert.Equal(t, testUsername, p.Subject)

	req2, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req2.SetBasicAuth(testUsername, "wrong")
	ctx2 := WithRequest(context.Background(), req2)
	_, err = authn.Authenticate(ctx2)
	assert.ErrorIs(t, err, ErrUnauthenticated)
}

func TestBasicAuthenticator_MissingUsername(t *testing.T) {
	t.Parallel()
	_, err := NewBasicAuthenticator(BasicAuthConfig{PasswordHash: "x"})
	assert.Error(t, err)
}

func TestMultiAuthenticator(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	basic, _ := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: string(ph),
	})

	multi := NewMultiAuthenticator(basic)

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req.SetBasicAuth(testUsername, testPassword)
	ctx := WithRequest(context.Background(), req)
	p, err := multi.Authenticate(ctx)
	require.NoError(t, err)
	assert.Equal(t, testUsername, p.Subject)

	ctx2 := context.Background()
	_, err = multi.Authenticate(ctx2)
	assert.Error(t, err)
}

func TestRBACAuthorizer(t *testing.T) {
	t.Parallel()
	rules := []RBACRule{
		{
			Subjects:   []string{"admin"},
			Actions:    []string{"*"},
			Resources:  []string{"*"},
			Namespaces: []string{"*"},
		},
		{
			Subjects:   []string{"group:readers"},
			Actions:    []string{"read"},
			Resources:  []string{"applications"},
			Namespaces: []string{testNS},
		},
	}

	authz := NewRBACAuthorizer(rules)

	admin := &Principal{Subject: "admin"}
	require.NoError(t, authz.Authorize(context.Background(), admin, ActionWrite, ResourceApplications, "prod", ""))

	reader := &Principal{Subject: "bob", Groups: []string{"readers"}}
	require.NoError(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, testNS, ""))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionWrite, ResourceApplications, testNS, ""))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, "prod", ""))

	unknown := &Principal{Subject: "eve"}
	assert.Error(t, authz.Authorize(context.Background(), unknown, ActionRead, ResourceApplications, testNS, ""))
}

func TestRBACAuthorizer_Projects(t *testing.T) {
	t.Parallel()
	authz := NewRBACAuthorizer([]RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"applications"},
		Namespaces: []string{"*"},
		Projects:   []string{"payments"},
	}})
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "payments"))
	assert.Error(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "other"))
}

func TestAllowAllAuthorizer(t *testing.T) {
	t.Parallel()
	authz := &AllowAllAuthorizer{}
	assert.NoError(t, authz.Authorize(context.Background(), &Principal{}, ActionAdmin, ResourceApplications, "*", ""))
}

func TestDenyAllAuthorizer(t *testing.T) {
	t.Parallel()
	authz := &DenyAllAuthorizer{}
	assert.Error(t, authz.Authorize(context.Background(), &Principal{}, ActionRead, ResourceApplications, "", ""))
}

func TestClassify(t *testing.T) {
	t.Parallel()
	action, resource := classify("/paprika.v1.PaprikaService/ListApplications")
	assert.Equal(t, ActionRead, action)
	assert.Equal(t, ResourceApplications, resource)

	action, resource = classify("/paprika.v1.PaprikaService/SyncApplication")
	assert.Equal(t, ActionWrite, action)
	assert.Equal(t, ResourceApplications, resource)
}

func TestNamespaceFromRequest(t *testing.T) {
	t.Parallel()
	ns := testNS
	req := connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns})
	got := namespaceFromRequest(req)
	assert.Equal(t, testNS, got)
}

func TestInterceptor_Disabled(t *testing.T) {
	t.Parallel()
	interceptor, err := Interceptor(context.Background(), Config{Enabled: false}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
	}

	wrapped := interceptor(next)
	ns := testNS
	resp, err := wrapped(context.Background(), connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.NoError(t, err)
	assert.NotNil(t, resp)
}

func TestInterceptor_BasicAuth(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
		RBACRules: []RBACRule{
			{Subjects: []string{"*"}, Actions: []string{"*"}, Resources: []string{"*"}, Namespaces: []string{"*"}},
		},
	}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		p := PrincipalFromContext(ctx)
		assert.NotNil(t, p)
		return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
	}
	wrapped := interceptor(next)

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req.SetBasicAuth(testUsername, testPassword)
	ctx := WithRequest(context.Background(), req)

	ns := testNS
	_, err = wrapped(ctx, connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.NoError(t, err)
}

func TestInterceptor_Unauthenticated(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
	}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Fatal("should not reach next")
		return nil, nil
	}
	wrapped := interceptor(next)

	ns := testNS
	_, err = wrapped(context.Background(), connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
}

func TestFleetQueryInterceptorDefersProjectSetAuthorization(t *testing.T) {
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
		// With no RBAC rules or project reader, BuildAuthorizer returns DenyAll.
		// Reaching the handlers therefore proves that middleware did not invoke
		// legacy single-project authorization with an empty project.
	}, nil)
	require.NoError(t, err)

	service := &fleetAuthTestService{t: t}
	_, handler := v1connect.NewPaprikaServiceHandler(
		service,
		connect.WithInterceptors(interceptor),
	)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := v1connect.NewPaprikaServiceClient(server.Client(), server.URL)
	authorization := "Basic " + base64.StdEncoding.EncodeToString([]byte(testUsername+":"+testPassword))

	calls := []struct {
		name string
		call func() error
	}{
		{
			name: "applications",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryApplicationsRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryApplications(context.Background(), req)
				return callErr
			},
		},
		{
			name: "map",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryFleetMapRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryFleetMap(context.Background(), req)
				return callErr
			},
		},
		{
			name: "matrix",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryFleetMatrix(context.Background(), req)
				return callErr
			},
		},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, tc.call())
		})
	}
	assert.Equal(t, 3, service.fleetCalls)

	_, err = client.QueryApplications(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryApplicationsRequest{}),
	)
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	assert.Equal(t, 3, service.fleetCalls, "authentication must still precede the fleet handler")

	listReq := connect.NewRequest(&paprikav1.ListApplicationsRequest{})
	listReq.Header().Set("Authorization", authorization)
	_, err = client.ListApplications(context.Background(), listReq)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	assert.Zero(t, service.legacyCalls, "the bypass must be limited to fleet project-set queries")
}

type fleetAuthTestService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	t           *testing.T
	fleetCalls  int
	legacyCalls int
}

func (s *fleetAuthTestService) QueryApplications(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryApplicationsRequest],
) (*connect.Response[paprikav1.QueryApplicationsResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryApplicationsResponse{}), nil
}

func (s *fleetAuthTestService) QueryFleetMap(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryFleetMapRequest],
) (*connect.Response[paprikav1.QueryFleetMapResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryFleetMapResponse{}), nil
}

func (s *fleetAuthTestService) QueryFleetMatrix(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryFleetMatrixRequest],
) (*connect.Response[paprikav1.QueryFleetMatrixResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryFleetMatrixResponse{}), nil
}

func (s *fleetAuthTestService) ListApplications(
	context.Context,
	*connect.Request[paprikav1.ListApplicationsRequest],
) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	s.legacyCalls++
	return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
}

func (s *fleetAuthTestService) requirePrincipal(ctx context.Context) {
	s.t.Helper()
	principal := PrincipalFromContext(ctx)
	require.NotNil(s.t, principal)
	assert.Equal(s.t, testUsername, principal.Subject)
}

func TestStringSlice(t *testing.T) {
	t.Parallel()
	assert.Equal(t, []string{"a", "b"}, stringSlice([]interface{}{"a", "b"}))
	assert.Equal(t, []string{"x"}, stringSlice("x"))
	assert.Equal(t, []string{"a", "b"}, stringSlice([]string{"a", "b"}))
}
