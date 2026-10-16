package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/cache"
)

const nativeContractOrigin = "https://paprika.example"
const nativeContractResource = nativeContractOrigin + "/observe/mcp"
const nativeContractRedirect = "http://127.0.0.1:8791/native-contract-callback"

// This fixture deliberately does not use testIssuer (which is empty). Tokens
// minted by the HTTP token endpoint must satisfy the real nonempty origin
// issuer as well as the distinct observability audience.
func newNativeOAuthContractServer(t *testing.T) (*Server, *http.ServeMux, string, string) {
	t.Helper()
	store, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { assert.NoError(t, store.Close()) })
	console, err := auth.BuildAuthenticator(t.Context(), auth.Config{Enabled: true, TokenSecret: testSecret})
	require.NoError(t, err)
	srv, err := NewServer(ServerConfig{
		Registry: NewRegistry(), Authenticator: mustAudienceAuthenticator(t, testSecret, ObservabilityTokenAudience, nativeContractOrigin),
		ConsoleAuthenticator: console, Confirmer: NewConfirmer(store, time.Minute), Auditor: &recordingAuditor{},
		Cache: store, Secret: testSecret, PublicURL: nativeContractOrigin, AllowDynamicRegistrationOnly: true,
		RoutePrefix: "/observe", ProtocolPath: "/observe/mcp", Audience: ObservabilityTokenAudience,
		SupportedScopes: []Scope{ScopeObserve}, DisableConsoleResources: true,
	})
	require.NoError(t, err)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	mux.Handle("/observe/mcp", srv.Handler())
	consoleBearer, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "native-contract-user", Audience: auth.ConsoleAPIAudience, Issuer: nativeContractOrigin,
		TTL: time.Hour, Secret: testSecret,
	})
	require.NoError(t, err)
	registered := postJSON(t, mux, "/observe/register", "", registrationRequest{
		RedirectURIs: []string{nativeContractRedirect}, ClientName: "Native contract fixture", TokenEndpointAuthMethod: "none",
	})
	require.Equal(t, http.StatusCreated, registered.Code)
	//nolint:tagliatelle // RFC 7591 DCR response field.
	var registration struct {
		ClientID string `json:"client_id"`
	}
	require.NoError(t, json.Unmarshal(registered.Body.Bytes(), &registration))
	require.NotEmpty(t, registration.ClientID)
	return srv, mux, registration.ClientID, consoleBearer
}

func nativeContractConsentCode(t *testing.T, mux *http.ServeMux, clientID, consoleBearer string) string {
	t.Helper()
	consented := postJSON(t, mux, "/observe/authorize/consent", consoleBearer, consentRequest{
		ClientID: clientID, RedirectURI: nativeContractRedirect, State: "known-nonsecret-contract-state",
		CodeChallenge: pkceChallengeForFix1, CodeChallengeMethod: "S256", Scopes: []string{"paprika:observe"}, Decision: decisionApprove,
	})
	require.Equal(t, http.StatusOK, consented.Code)
	var handoff consentResponse
	require.NoError(t, json.Unmarshal(consented.Body.Bytes(), &handoff))
	dest, err := url.Parse(handoff.RedirectTo)
	require.NoError(t, err)
	require.Equal(t, "known-nonsecret-contract-state", dest.Query().Get("state"))
	code := dest.Query().Get("code")
	require.NotEmpty(t, code)
	return code
}

func TestObserveNativeResourceIndicators(t *testing.T) {
	srv := newObservabilityTestServer(t, nil, nil)
	for _, tc := range []struct {
		name      string
		resources []string
		want      bool
	}{
		{"missing first-party compatibility", nil, true},
		{"single target", []string{nativeContractResource}, true},
		{"native repeated same target", []string{nativeContractResource, nativeContractResource}, true},
		{"three copies same target", []string{nativeContractResource, nativeContractResource, nativeContractResource}, true},
		{"existing URL equivalence", []string{nativeContractResource, "HTTPS://PAPRIKA.EXAMPLE/observe/mcp"}, true},
		{"foreign only", []string{"https://foreign.example/observe/mcp"}, false},
		{"foreign first", []string{"https://foreign.example/observe/mcp", nativeContractResource}, false},
		{"foreign last", []string{nativeContractResource, "https://foreign.example/observe/mcp"}, false},
		{"fleet audience mixed", []string{nativeContractResource, nativeContractOrigin + "/mcp"}, false},
		{"repeated query target", []string{nativeContractResource + "?private=fixture", nativeContractResource + "?private=fixture"}, false},
		{"empty query component", []string{nativeContractResource, nativeContractResource + "?"}, false},
		{"repeated fragment target", []string{nativeContractResource + "#fixture", nativeContractResource + "#fixture"}, false},
		{"empty fragment component", []string{nativeContractResource, nativeContractResource + "#"}, false},
		{"userinfo", []string{nativeContractResource, "https://fixture@paprika.example/observe/mcp"}, false},
		{"escaped foreign path", []string{nativeContractResource, nativeContractOrigin + "/observe%2fmcp"}, false},
		{"empty indicator mixed", []string{nativeContractResource, ""}, false},
	} {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, srv.validResource(tc.resources)) })
	}
}

func TestObserveNativeAuthorizeRepeatedResourceAndRejectMixedTargets(t *testing.T) {
	_, mux, clientID, consoleBearer := newNativeOAuthContractServer(t)
	for _, tc := range []struct {
		name      string
		resources []string
		valid     bool
	}{
		{"same target repeated", []string{nativeContractResource, nativeContractResource}, true},
		{"foreign first", []string{"https://foreign.example/observe/mcp", nativeContractResource}, false},
		{"foreign last", []string{nativeContractResource, "https://foreign.example/observe/mcp"}, false},
		{"query repeated", []string{nativeContractResource + "?fixture=1", nativeContractResource + "?fixture=1"}, false},
		{"empty query", []string{nativeContractResource, nativeContractResource + "?"}, false},
		{"fragment repeated", []string{nativeContractResource + "#fixture", nativeContractResource + "#fixture"}, false},
		{"empty fragment", []string{nativeContractResource, nativeContractResource + "#"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := url.Values{"client_id": {clientID}, "redirect_uri": {nativeContractRedirect},
				"response_type": {"code"}, "code_challenge": {pkceChallengeForFix1}, "code_challenge_method": {"S256"},
				"scope": {"paprika:observe"}, "state": {"known-nonsecret-contract-state"}, "resource": tc.resources}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/authorize?"+query.Encode(), nil)
			req.Header.Set("Accept", "text/html")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			require.Equal(t, http.StatusFound, rec.Code, "anonymous browser shape is unchanged for invalid requests")
			location, err := url.Parse(rec.Header().Get("Location"))
			require.NoError(t, err)
			require.Equal(t, "/observe/consent", location.Path)
			require.Len(t, location.Query(), 1)
			rid := location.Query().Get("rid")
			require.NotEmpty(t, rid)
			pending := httptest.NewRecorder()
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/authorize/pending?rid="+url.QueryEscape(rid), nil)
			request.Header.Set("Authorization", "Bearer "+consoleBearer)
			mux.ServeHTTP(pending, request)
			if tc.valid {
				require.Equal(t, http.StatusOK, pending.Code)
				var actual pendingAuthzResponse
				require.NoError(t, json.Unmarshal(pending.Body.Bytes(), &actual))
				assert.Equal(t, clientID, actual.ClientID)
				assert.Equal(t, "paprika:observe", actual.Scope)
			} else {
				require.Equal(t, http.StatusBadRequest, pending.Code)
				var failure oauthError
				require.NoError(t, json.Unmarshal(pending.Body.Bytes(), &failure))
				assert.Equal(t, "invalid_request", failure.Error)
				assert.NotContains(t, pending.Body.String(), "foreign.example")
			}
		})
	}
}

func TestObserveNativeTokenResourceRejectionDoesNotConsumeGrants(t *testing.T) {
	srv, mux, clientID, consoleBearer := newNativeOAuthContractServer(t)
	for _, tc := range []struct {
		name      string
		resources []string
	}{
		{"mixed audience", []string{nativeContractResource, nativeContractOrigin + "/mcp"}},
		{"foreign duplicates", []string{"https://foreign.example/observe/mcp", "https://foreign.example/observe/mcp"}},
		{"query duplicates", []string{nativeContractResource + "?fixture=1", nativeContractResource + "?fixture=1"}},
		{"empty query", []string{nativeContractResource, nativeContractResource + "?"}},
		{"fragment duplicates", []string{nativeContractResource + "#fixture", nativeContractResource + "#fixture"}},
		{"empty fragment", []string{nativeContractResource, nativeContractResource + "#"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code := nativeContractConsentCode(t, mux, clientID, consoleBearer)
			form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "redirect_uri": {nativeContractRedirect},
				"code": {code}, "code_verifier": {pkceVerifierForFix1}, "resource": tc.resources}
			denied := postForm(t, mux, "/observe/token", form)
			require.Equal(t, http.StatusBadRequest, denied.Code)
			var failure oauthError
			require.NoError(t, json.Unmarshal(denied.Body.Bytes(), &failure))
			assert.Equal(t, "invalid_target", failure.Error)
			form["resource"] = []string{nativeContractResource, nativeContractResource}
			accepted := postForm(t, mux, "/observe/token", form)
			require.Equal(t, http.StatusOK, accepted.Code, "invalid resource must not consume the authorization code")
			var pair tokenResponse
			require.NoError(t, json.Unmarshal(accepted.Body.Bytes(), &pair))
			require.Equal(t, "paprika:observe", pair.Scope)
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/observe/mcp", nil)
			request.Header.Set("Authorization", "Bearer "+pair.AccessToken)
			principal, err := srv.authenticator.Authenticate(auth.WithRequest(t.Context(), request))
			require.NoError(t, err, "HTTP-minted token must satisfy nonempty strict issuer and observe audience")
			assert.Equal(t, []string{"paprika:observe"}, principal.Scopes)
			refresh := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {pair.RefreshToken}, "resource": tc.resources}
			denied = postForm(t, mux, "/observe/token", refresh)
			require.Equal(t, http.StatusBadRequest, denied.Code)
			require.NoError(t, json.Unmarshal(denied.Body.Bytes(), &failure))
			assert.Equal(t, "invalid_target", failure.Error)
			refresh["resource"] = []string{nativeContractResource, nativeContractResource}
			accepted = postForm(t, mux, "/observe/token", refresh)
			require.Equal(t, http.StatusOK, accepted.Code, "invalid resource must not consume the refresh token")
		})
	}
}
