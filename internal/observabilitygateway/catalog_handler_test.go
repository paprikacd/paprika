package observabilitygateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const catalogTestIssuer = "https://paprika.example"

// catalogTestToken mints a paprika-observability token the way the gateway's
// own OAuth flow would: audience-bound to this surface, issued by the public
// URL the authenticator checks, carrying exactly the scopes given.
func catalogTestToken(t *testing.T, secret []byte, scopes ...string) string {
	t.Helper()
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Email: "test@example.com", Name: "Test",
		Audience: mcp.ObservabilityTokenAudience, Issuer: catalogTestIssuer,
		Scope: strings.Join(scopes, " "), TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)
	return token
}

// newCatalogTestMux mounts the catalog and validate handlers behind the
// shared RequireObserveScope middleware, exactly as cmd's
// buildObservabilityMux does, so handler and authz behaviour are exercised
// together.
func newCatalogTestMux(t *testing.T) (*http.ServeMux, []byte) {
	t.Helper()
	secret := []byte("catalog-test-secret")
	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(secret, mcp.ObservabilityTokenAudience, catalogTestIssuer)
	require.NoError(t, err)
	gatewayAPI := RequireObserveScope(authenticator, catalogTestIssuer, "/observe")
	mux := http.NewServeMux()
	mux.Handle("GET /observe/api/catalog", gatewayAPI(CatalogHandler()))
	mux.Handle("GET /observe/api/catalog/{type}", gatewayAPI(CatalogTypeHandler()))
	mux.Handle("POST /observe/api/validate", gatewayAPI(ValidateHandler()))
	return mux, secret
}

func doCatalogRequest(t *testing.T, mux http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// requireAuthError decodes an RFC 6749-shaped error body and asserts its
// fixed fields.
func requireAuthError(t *testing.T, rec *httptest.ResponseRecorder, code, description string) {
	t.Helper()
	var body gatewayError
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, code, body.Error)
	assert.Equal(t, description, body.ErrorDescription)
}

func TestCatalogEndpointsRequireAuthentication(t *testing.T) {
	t.Parallel()
	mux, _ := newCatalogTestMux(t)

	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog", "", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"),
		`resource_metadata="`+catalogTestIssuer+`/observe/.well-known/oauth-protected-resource"`)
	requireAuthError(t, rec, "invalid_token", "a paprika-observability bearer token is required")

	rec = doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog/loki", "", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	rec = doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", "", `{"type":"loki"}`)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestCatalogEndpointsRejectMissingScope(t *testing.T) {
	t.Parallel()
	mux, secret := newCatalogTestMux(t)
	token := catalogTestToken(t, secret, string(mcp.ScopeRead))

	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog", token, "")
	require.Equal(t, http.StatusForbidden, rec.Code)
	requireAuthError(t, rec, "insufficient_scope", "the paprika:observe scope is required")

	rec = doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"type":"loki"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestCatalogHandlerListsSummaries(t *testing.T) {
	t.Parallel()
	mux, secret := newCatalogTestMux(t)

	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog", catalogTestToken(t, secret, string(mcp.ScopeObserve)), "")
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Types []catalog.TypeSummary `json:"types"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	require.Len(t, body.Types, 16)
	// The catalog's deterministic order is Vendor then DisplayName: AWS
	// sorts before Google Cloud and Open source, and "AWS CloudTrail"
	// before "AWS X-Ray".
	assert.Equal(t, connector.ProviderAWSCloudTrail, body.Types[0].Type)
	assert.Equal(t, "AWS CloudTrail", body.Types[0].DisplayName)
	assert.Equal(t, "AWS", body.Types[0].Vendor)
	assert.NotEmpty(t, body.Types[0].Summary)
}

func TestCatalogTypeHandlerServesTypeInfo(t *testing.T) {
	t.Parallel()
	mux, secret := newCatalogTestMux(t)
	token := catalogTestToken(t, secret, string(mcp.ScopeObserve))

	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog/loki", token, "")
	require.Equal(t, http.StatusOK, rec.Code)

	var info catalog.TypeInfo
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&info))
	assert.Equal(t, connector.ProviderLoki, info.Type)
	assert.Equal(t, "Grafana Loki", info.DisplayName)
	assert.NotEmpty(t, info.ConfigFields)
	assert.NotEmpty(t, info.Steps)
	assert.Equal(t, connector.SignalLogs, info.Probe.Signal)

	t.Run("unknown type answers 404 without leaking anything else", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog/nope", token, "")
		require.Equal(t, http.StatusNotFound, rec.Code)
		requireAuthError(t, rec, "invalid_request", reasonUnknownProviderType)
	})
}

func TestValidateHandlerValidatesConfigurationOffline(t *testing.T) {
	t.Parallel()
	mux, secret := newCatalogTestMux(t)
	token := catalogTestToken(t, secret, string(mcp.ScopeObserve))

	t.Run("valid configuration is checked without backend contact", func(t *testing.T) {
		var seen *http.Request
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen = r.Clone(r.Context())
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"success","data":{"result":[]}}`)
		}))
		t.Cleanup(server.Close)

		body := fmt.Sprintf(`{"type":"loki","config":{"endpoint":%q}}`, server.URL)
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, body)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp validateResponse
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
		assert.Equal(t, connector.StateOK, resp.State)
		assert.Contains(t, resp.Reason, "have not been tested")
		require.Nil(t, seen, "validation must never contact a caller-selected endpoint")
	})

	t.Run("credential payload is rejected before backend contact", func(t *testing.T) {
		var contacted bool
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			contacted = true
		}))
		t.Cleanup(server.Close)
		body := fmt.Sprintf(`{"type":"loki","config":{"endpoint":%q},"credentials":"test-only-sentinel"}`, server.URL)
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, body)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, contacted)
		assert.NotContains(t, rec.Body.String(), "test-only-sentinel")
	})

	t.Run("unknown type answers 404 with the fixed sentence", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"type":"nope","config":{}}`)
		require.Equal(t, http.StatusNotFound, rec.Code)
		requireAuthError(t, rec, "invalid_request", reasonUnknownProviderType)
	})

	t.Run("malformed body answers 400", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"type":`)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		requireAuthError(t, rec, "invalid_request", reasonValidateRequestInvalid)
	})

	t.Run("config that is not an object answers 400", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"type":"loki","config":"endpoint"}`)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		requireAuthError(t, rec, "invalid_request", reasonValidateRequestInvalid)
	})

	t.Run("missing type answers 400", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"config":{}}`)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		requireAuthError(t, rec, "invalid_request", reasonValidateRequestInvalid)
	})

	t.Run("absent config is not configured", func(t *testing.T) {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/validate", token, `{"type":"loki"}`)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp validateResponse
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
		assert.Equal(t, connector.StateNotConfigured, resp.State)
		assert.Equal(t, reasonNotConfigured, resp.Reason)
	})
}

func TestRequireObserveScopeRejectsWrongAudience(t *testing.T) {
	t.Parallel()
	mux, secret := newCatalogTestMux(t)
	// A fleet-MCP token (paprika-mcp audience) must not read the catalog,
	// even observe-scoped: the audience check fails first.
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Audience: mcp.MCPTokenAudience, Issuer: catalogTestIssuer,
		Scope: string(mcp.ScopeObserve), TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/catalog", token, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
