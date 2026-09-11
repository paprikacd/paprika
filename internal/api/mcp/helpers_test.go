package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	api "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
)

// testSecret and testIssuer parameterize every self-signed token minted or
// verified across this package's tests, so a token issued by one helper is
// always accepted by an authenticator built by another.
var testSecret = []byte("mcp-test-secret-mcp-test-secret")

// testIssuer is deliberately empty: bearerFor (below) mints tokens with no
// "iss" claim, matching NewSelfSignedAuthenticatorForAudience's rule that an
// empty issuer skips the issuer check entirely (only audience is mandatory).
// A non-empty testIssuer here would make every token bearerFor mints fail
// issuer verification, since it never sets one.
const testIssuer = ""

// mustAudienceAuthenticator builds a self-signed authenticator that only
// accepts tokens minted for audience, failing the test immediately if the
// audience is empty (NewSelfSignedAuthenticatorForAudience rejects that at
// construction).
func mustAudienceAuthenticator(t *testing.T, secret []byte, audience, issuer string) auth.Authenticator {
	t.Helper()
	a, err := auth.NewSelfSignedAuthenticatorForAudience(secret, audience, issuer)
	require.NoError(t, err)
	return a
}

// recordingAuditor is an audit.Auditor that keeps every event it is given,
// so tests can assert on what was recorded rather than just that something
// was.
type recordingAuditor struct{ events []audit.Event }

func (r *recordingAuditor) Record(_ context.Context, e audit.Event) {
	r.events = append(r.events, e)
}

// stubTool returns a tool whose Invoke succeeds without touching Connect, so
// invoker tests exercise gating rather than RPC behaviour.
func stubTool(name string, scope Scope, destructive bool) Tool {
	return Tool{
		Name:        name,
		Description: name,
		Scope:       scope,
		Destructive: destructive,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return map[string]string{"ok": name}, nil
		},
	}
}

// echoService answers every RPC. UnimplementedPaprikaServiceHandler returns
// CodeUnimplemented, which is fine for gating tests but not for audit tests —
// the audit interceptor records the attempt either way, which is exactly the
// behaviour under test.
type echoService struct {
	v1connect.UnimplementedPaprikaServiceHandler
}

// stubConnectClient returns a client wired through the REAL audit interceptor,
// so audit assertions exercise the production audit path rather than a
// reimplementation of it.
//
// The client must not be nil: the real write tools registered by
// RegisterWriteTools dereference it inside Invoke, so nil panics rather than
// failing cleanly. This is why newInvokerForRegistry cannot pass nil.
func stubConnectClient(t *testing.T, aud audit.Auditor) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(&echoService{},
		connect.WithInterceptors(api.NewAuditInterceptor(aud, nil)))
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")
}

// newInvokerForRegistry wires an invoker around an existing registry.
func newInvokerForRegistry(t *testing.T, r *Registry) (*Invoker, *recordingAuditor) {
	t.Helper()
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	aud := &recordingAuditor{}
	return NewInvoker(r, stubConnectClient(t, aud), NewConfirmer(store, time.Minute), aud), aud
}

// newTestInvoker builds the three-tool registry used by the invoker tests.
func newTestInvoker(t *testing.T) (*Invoker, *recordingAuditor) {
	t.Helper()
	r := NewRegistry()
	require.NoError(t, r.Register(stubTool("fleet_status", ScopeRead, false)))
	require.NoError(t, r.Register(stubTool("sync_application", ScopeWrite, false)))
	require.NoError(t, r.Register(stubTool("rollback_release", ScopeWrite, true)))
	return newInvokerForRegistry(t, r)
}

// withConfirmation injects a confirmation token into an argument object,
// leaving all other fields byte-identical so the argument hash still matches.
func withConfirmation(args json.RawMessage, token string) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(args, &obj); err != nil {
		return nil, err
	}
	obj["confirmation_token"] = token
	return json.Marshal(obj)
}

// newTestServer builds a server over the full tool registry with auth enabled.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)

	srv, err := NewServer(ServerConfig{
		Registry:      r,
		Authenticator: mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer),
		// ConsoleAuthenticator stands in for the real console authenticator
		// stack (auth.BuildAuthenticator: OIDC + self-signed, no audience
		// restriction) that cmd/main.go wires in production. A plain
		// self-signed authenticator with no audience check is enough here:
		// it accepts both a genuine console token (consoleBearerFor) and,
		// since it never checks "aud" at all, the MCP-audience tokens
		// bearerFor mints too — so the pre-existing tests that authenticate
		// straight to GET /mcp/authorize with an MCP access token keep
		// working unchanged.
		ConsoleAuthenticator: auth.NewSelfSignedAuthenticator(testSecret),
		Confirmer:            NewConfirmer(store, time.Minute),
		Auditor:              &recordingAuditor{},
		Cache:                store,
		Secret:               testSecret,
		PublicURL:            "https://paprika.example",
		ClientID:             "test",
		RedirectURIs:         []string{"https://claude.ai/api/mcp/auth_callback"},
	})
	require.NoError(t, err)
	return srv
}

// bearerFor mints a valid MCP access token carrying the given scopes.
func bearerFor(t *testing.T, scopes ...Scope) string {
	t.Helper()
	raw := make([]string, len(scopes))
	for i, s := range scopes {
		raw[i] = string(s)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Email: "test@example.com", Name: "Test",
		Audience: "paprika-mcp", Scope: strings.Join(raw, " "),
		TTL: time.Hour, Secret: testSecret,
	})
	require.NoError(t, err)
	return token
}

// consoleBearerFor mints a plain console-style self-signed token: no
// audience claim and no scope claim, matching exactly what /auth/token
// issues once a human has completed the existing Google OIDC login. This is
// deliberately different from bearerFor, which always stamps
// aud=paprika-mcp and an explicit scope — modelling an MCP access token, not
// the console credential /mcp/authorize/consent must accept.
func consoleBearerFor(t *testing.T, subject string) string {
	t.Helper()
	token, err := auth.IssueToken(subject, subject+"@example.com", "Test User", testSecret)
	require.NoError(t, err)
	return token
}

// postJSON posts body, marshalled as JSON, to path on h — optionally with an
// Authorization bearer header, which is omitted entirely when bearer is "" —
// and returns the recorded response. The POST /mcp/authorize/consent
// equivalent of postForm.
func postJSON(t *testing.T, h http.Handler, path, bearer string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	h.ServeHTTP(rec, req)
	return rec
}

// doJSONRPC posts a JSON-RPC envelope to /mcp and returns the response body.
func doJSONRPC(t *testing.T, srv *Server, body, token string) []byte {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
	return rec.Body.Bytes()
}

// newTestServerWithCache exposes the backing store for refresh-token seeding.
func newTestServerWithCache(t *testing.T) (*Server, *cache.Cache) {
	t.Helper()
	srv := newTestServer(t)
	return srv, srv.cache
}

// newTestServerWithRedirects configures the exact-match redirect allowlist.
func newTestServerWithRedirects(t *testing.T, redirects []string) *Server {
	t.Helper()
	srv := newTestServer(t)
	srv.clientID = "test"
	srv.redirectURIs = redirects
	return srv
}

// postForm posts an application/x-www-form-urlencoded body to path on h and
// returns the recorded response, for driving /mcp/token in tests.
func postForm(t *testing.T, h http.Handler, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(rec, req)
	return rec
}

// seedRefreshToken writes a refresh record directly to store so tests do not
// need to drive the full browser authorization-code flow to exercise
// refresh-token rotation.
func seedRefreshToken(t *testing.T, store *cache.Cache, subject, scope string) string {
	t.Helper()
	token := "refresh-" + subject
	payload, err := json.Marshal(map[string]string{"sub": subject, "scope": scope})
	require.NoError(t, err)
	require.NoError(t, store.Set(context.Background(), "mcp:refresh:"+token, payload, time.Hour))
	return token
}

// ctxWithBearer builds a context carrying an HTTP request with token as its
// Bearer credential, suitable for calling an auth.Authenticator directly in
// a test without going through a Server's mux.
func ctxWithBearer(token string) context.Context {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return auth.WithRequest(context.Background(), req)
}
