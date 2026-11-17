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

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/cache"
)

// newObservabilityTestServer builds the second MCP surface the
// observability-gateway mode serves: everything hangs under /observe, tokens
// carry the paprika-observability audience, only paprika:observe is granted,
// and the console resource extensions are off. It exists so these tests pin
// the exact shape the gateway relies on — a regression here is a regression
// in the gateway's public contract.
func newObservabilityTestServer(t *testing.T, r *Registry, redirectURIs []string, scopes ...Scope) *Server {
	t.Helper()
	if len(scopes) == 0 {
		scopes = []Scope{ScopeObserve}
	}
	if r == nil {
		r = NewRegistry()
	}
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	consoleAuthenticator, err := auth.BuildAuthenticator(context.Background(), auth.Config{
		Enabled:     true,
		TokenSecret: testSecret,
	})
	require.NoError(t, err)
	if len(redirectURIs) == 0 {
		redirectURIs = []string{"http://127.0.0.1:8791/callback"}
	}
	srv, err := NewServer(ServerConfig{
		Registry:                r,
		Authenticator:           mustAudienceAuthenticator(t, testSecret, ObservabilityTokenAudience, testIssuer),
		ConsoleAuthenticator:    consoleAuthenticator,
		Confirmer:               NewConfirmer(store, time.Minute),
		Auditor:                 &recordingAuditor{},
		Cache:                   store,
		Secret:                  testSecret,
		PublicURL:               "https://paprika.example",
		ClientID:                "test",
		RedirectURIs:            redirectURIs,
		RoutePrefix:             "/observe",
		ProtocolPath:            "/observe/mcp",
		Audience:                ObservabilityTokenAudience,
		SupportedScopes:         scopes,
		DisableConsoleResources: true,
	})
	require.NoError(t, err)
	return srv
}

// observeBearerFor mints a paprika-observability-audience token carrying the
// given scopes — the gateway-surface counterpart of bearerFor.
func observeBearerFor(t *testing.T, scopes ...Scope) string {
	t.Helper()
	raw := make([]string, len(scopes))
	for i, s := range scopes {
		raw[i] = string(s)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Email: "test@example.com", Name: "Test",
		Audience: ObservabilityTokenAudience, Scope: strings.Join(raw, " "),
		TTL: time.Hour, Secret: testSecret,
	})
	require.NoError(t, err)
	return token
}

func TestObservabilitySurfaceDiscoveryMetadata(t *testing.T) {
	mux := http.NewServeMux()
	newObservabilityTestServer(t, nil, nil).RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/observe/.well-known/oauth-protected-resource", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var resource struct {
		Resource             string   `json:"resource"`
		AuthorizationServers []string `json:"authorization_servers"`
		ScopesSupported      []string `json:"scopes_supported"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resource))
	assert.Equal(t, "https://paprika.example/observe/mcp", resource.Resource)
	assert.Equal(t, []string{"https://paprika.example/observe"}, resource.AuthorizationServers)
	assert.Equal(t, []string{"paprika:observe"}, resource.ScopesSupported)

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/observe/.well-known/oauth-authorization-server", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	//nolint:tagliatelle // matches the snake_case wire format oauth.go emits.
	var server struct {
		Issuer                string   `json:"issuer"`
		AuthorizationEndpoint string   `json:"authorization_endpoint"`
		TokenEndpoint         string   `json:"token_endpoint"`
		RegistrationEndpoint  string   `json:"registration_endpoint"`
		ScopesSupported       []string `json:"scopes_supported"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &server))
	assert.Equal(t, "https://paprika.example/observe", server.Issuer)
	assert.Equal(t, "https://paprika.example/observe/authorize", server.AuthorizationEndpoint)
	assert.Equal(t, "https://paprika.example/observe/token", server.TokenEndpoint)
	assert.Equal(t, "https://paprika.example/observe/register", server.RegistrationEndpoint)
	assert.Equal(t, []string{"paprika:observe"}, server.ScopesSupported)

	// The host-root well-knowns belong to the console surface only: a
	// prefixed server must not answer them, or two surfaces on one hostname
	// would race to describe the host.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/.well-known/oauth-protected-resource", nil))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestObservabilitySurfaceOAuthRoutesAreMountedUnderPrefix(t *testing.T) {
	mux := http.NewServeMux()
	newObservabilityTestServer(t, nil, nil).RegisterOAuthRoutes(mux)

	// Every OAuth endpoint answers from under /observe — a 401/302/400/405
	// proves the handler is mounted; a 404 would prove it is not.
	for _, path := range []string{
		"/observe/authorize",
		"/observe/authorize/pending",
		"/observe/authorize/consent",
		"/observe/token",
		"/observe/register",
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
		assert.NotEqual(t, http.StatusNotFound, rec.Code, "%s must be mounted", path)
	}
}

func TestObservabilitySurfaceConsentGrantsOnlyObserve(t *testing.T) {
	const redirect = "http://127.0.0.1:8791/callback"
	srv := newObservabilityTestServer(t, nil, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	// A scope this server does not grant is rejected at consent time, even
	// though paprika:read is a perfectly valid scope on the console surface.
	denied := postJSON(t, mux, "/observe/authorize/consent", consoleBearerFor(t, "obs-user"), consentRequest{
		ClientID: "test", RedirectURI: redirect, State: "obs-state",
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{"paprika:read"}, Decision: decisionApprove,
	})
	assert.Equal(t, http.StatusBadRequest, denied.Code)

	consent := postJSON(t, mux, "/observe/authorize/consent", consoleBearerFor(t, "obs-user"), consentRequest{
		ClientID: "test", RedirectURI: redirect, State: "obs-state",
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256",
		Scopes: []string{"paprika:observe"}, Decision: decisionApprove,
	})
	require.Equal(t, http.StatusOK, consent.Code, consent.Body.String())
	var handoff consentResponse
	require.NoError(t, json.Unmarshal(consent.Body.Bytes(), &handoff))
	dest, err := url.Parse(handoff.RedirectTo)
	require.NoError(t, err)
	code := dest.Query().Get("code")
	require.NotEmpty(t, code)

	resp := postForm(t, mux, "/observe/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {"test"},
		"code": {code}, "redirect_uri": {redirect},
		"code_verifier": {pkceVerifierForFix1},
	})
	require.Equal(t, http.StatusOK, resp.Code, resp.Body.String())
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &pair))
	assert.Equal(t, "paprika:observe", pair.Scope)

	// The gateway's authenticator accepts the minted token; the console MCP
	// surface's must not — the audience split is what keeps an observability
	// token from being replayed against /mcp and vice versa.
	obsAuth := mustAudienceAuthenticator(t, testSecret, ObservabilityTokenAudience, testIssuer)
	p, err := obsAuth.Authenticate(ctxWithBearer(pair.AccessToken))
	require.NoError(t, err)
	assert.Equal(t, "obs-user", p.Subject)
	assert.Equal(t, []string{"paprika:observe"}, p.Scopes)

	mcpAuth := mustAudienceAuthenticator(t, testSecret, MCPTokenAudience, testIssuer)
	_, err = mcpAuth.Authenticate(ctxWithBearer(pair.AccessToken))
	assert.Error(t, err, "an observability token must not be replayable against the console MCP surface")
}

func TestObservabilitySurfaceToolsListMarksObserveToolsReadOnly(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(stubTool("query_metrics", ScopeObserve, false)))
	srv := newObservabilityTestServer(t, r, nil)

	body := doJSONRPC(t, srv,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`,
		observeBearerFor(t, ScopeObserve))
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	var result struct {
		Tools []struct {
			Name        string `json:"name"`
			Annotations struct {
				ReadOnlyHint    bool `json:"readOnlyHint"`
				DestructiveHint bool `json:"destructiveHint"`
			} `json:"annotations"`
		} `json:"tools"`
	}
	require.NoError(t, json.Unmarshal(envelope.Result, &result))
	require.Len(t, result.Tools, 1)
	assert.Equal(t, "query_metrics", result.Tools[0].Name)
	assert.True(t, result.Tools[0].Annotations.ReadOnlyHint, "observe tools are read-only")
	assert.False(t, result.Tools[0].Annotations.DestructiveHint)

	// Console extensions stay off this surface: no fleet resource, no
	// application template, no console tools.
	body = doJSONRPC(t, srv,
		`{"jsonrpc":"2.0","id":2,"method":"resources/templates/list","params":{}}`,
		observeBearerFor(t, ScopeObserve))
	require.NoError(t, json.Unmarshal(body, &envelope))
	var templates struct {
		ResourceTemplates []struct {
			URITemplate string `json:"uriTemplate"`
		} `json:"resourceTemplates"`
	}
	require.NoError(t, json.Unmarshal(envelope.Result, &templates))
	assert.Empty(t, templates.ResourceTemplates)
}

func TestObservabilitySurfaceRejectsForeignAudienceToken(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(stubTool("query_metrics", ScopeObserve, false)))
	srv := newObservabilityTestServer(t, r, nil)

	// A console-surface MCP token (aud=paprika-mcp, read scope) authenticates
	// fine on the console surface but must be a 401 here.
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/observe/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearerFor(t, ScopeRead))
	srv.Handler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"),
		`resource_metadata="https://paprika.example/observe/.well-known/oauth-protected-resource"`)
}

func TestParseScopesRecognizesObserve(t *testing.T) {
	assert.Equal(t, []Scope{ScopeObserve}, ParseScopes("paprika:observe"))
	assert.Equal(t, []Scope{ScopeRead, ScopeObserve}, ParseScopes("paprika:read paprika:observe"))
	assert.Empty(t, ParseScopes("paprika:metrics"), "unrecognised scopes are dropped, never widened")
}
