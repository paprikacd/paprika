package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	api "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
)

// --- Step 2's given tests, verbatim from the brief ---

func TestInitializeAdvertisesTools(t *testing.T) {
	srv := newTestServer(t)
	resp := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		bearerFor(t, ScopeRead))

	var out struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Annotations struct {
					ReadOnlyHint    bool `json:"readOnlyHint"`
					DestructiveHint bool `json:"destructiveHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(resp, &out))
	require.NotEmpty(t, out.Result.Tools)

	byName := map[string]bool{}
	for _, tool := range out.Result.Tools {
		byName[tool.Name] = tool.Annotations.ReadOnlyHint
	}
	assert.True(t, byName["fleet_status"], "read tools carry readOnlyHint")
	assert.False(t, byName["rollback_release"], "write tools must not")
}

func TestUnauthenticatedReturns401WithWWWAuthenticate(t *testing.T) {
	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	srv.Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "resource_metadata",
		"clients need this to discover the AS and re-run OAuth")
}

// --- NewServer's required-field validation ---

func TestNewServerRequiresRegistryAuthenticatorCacheAndSecret(t *testing.T) {
	valid := func() ServerConfig {
		store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
		require.NoError(t, err)
		return ServerConfig{
			Registry:      NewRegistry(),
			Authenticator: mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer),
			Cache:         store,
			Secret:        testSecret,
		}
	}

	t.Run("missing registry", func(t *testing.T) {
		cfg := valid()
		cfg.Registry = nil
		_, err := NewServer(cfg)
		require.Error(t, err)
	})
	t.Run("missing authenticator", func(t *testing.T) {
		cfg := valid()
		cfg.Authenticator = nil
		_, err := NewServer(cfg)
		require.Error(t, err)
	})
	t.Run("missing cache", func(t *testing.T) {
		cfg := valid()
		cfg.Cache = nil
		_, err := NewServer(cfg)
		require.Error(t, err)
	})
	t.Run("missing secret", func(t *testing.T) {
		cfg := valid()
		cfg.Secret = nil
		_, err := NewServer(cfg)
		require.Error(t, err)
	})
	t.Run("all required fields present", func(t *testing.T) {
		srv, err := NewServer(valid())
		require.NoError(t, err)
		require.NotNil(t, srv)
	})
}

// --- The blocker's required test ---
//
// statusStubService answers GetSystemStatus for real, so a tool call that
// reaches it can be asserted as an actual success rather than merely "not
// CodeUnauthenticated".
type statusStubService struct {
	v1connect.UnimplementedPaprikaServiceHandler
}

func (statusStubService) GetSystemStatus(
	context.Context, *connect.Request[v1.GetSystemStatusRequest],
) (*connect.Response[v1.GetSystemStatusResponse], error) {
	return connect.NewResponse(&v1.GetSystemStatusResponse{Total: 3}), nil
}

// authEnabledConnectClient wires a Connect client through the REAL production
// interceptor chain this package's blocker is about: auth.Interceptor (the
// exact interceptor auth/middleware.go:53 uses to reject unauthenticated
// requests with CodeUnauthenticated) followed by the real audit interceptor,
// serving statusStubService with no network hop. This is what distinguishes
// the test below from every other test in this package that calls
// newInvokerForRegistry / stubConnectClient: those wire only the audit
// interceptor and so cannot catch a missing-credential bug — see the task
// brief's blocker note, which explains that exact gap.
func authEnabledConnectClient(t *testing.T, aud audit.Auditor) v1connect.PaprikaServiceClient {
	t.Helper()
	authInterceptor, err := auth.Interceptor(context.Background(), auth.Config{
		Enabled:     true,
		TokenSecret: testSecret,
	}, nil)
	require.NoError(t, err)

	_, handler := v1connect.NewPaprikaServiceHandler(&statusStubService{},
		connect.WithInterceptors(authInterceptor, api.NewAuditInterceptor(aud, nil)))
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")
}

// TestToolCallAuthenticatesThroughInProcessTransport is the brief's required
// test: a tool call is run through a handler chain that HAS the auth
// interceptor enabled. Without transport.go's fix, the in-process request
// RoundTrip issues carries no Authorization header at all, so this fails
// CodeUnauthenticated even with a perfectly valid token sitting in the
// context — exactly the bug the blocker describes, and exactly what a test
// against stubConnectClient's auth-less chain cannot see.
func TestToolCallAuthenticatesThroughInProcessTransport(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))

	aud := &recordingAuditor{}
	client := authEnabledConnectClient(t, aud)
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	inv := NewInvoker(r, client, NewConfirmer(store, time.Minute), aud)
	principal := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	t.Run("no token in context -> CodeUnauthenticated", func(t *testing.T) {
		_, err := inv.Call(context.Background(), principal, "fleet_status", json.RawMessage(`{}`))
		require.Error(t, err)
		assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err),
			"the real auth interceptor must reject an in-process request carrying no credential")
	})

	t.Run("valid token in context -> succeeds", func(t *testing.T) {
		token := bearerFor(t, ScopeRead)
		ctx := WithBearerToken(context.Background(), token)
		result, err := inv.Call(ctx, principal, "fleet_status", json.RawMessage(`{}`))
		require.NoError(t, err)
		resp, ok := result.(*v1.GetSystemStatusResponse)
		require.True(t, ok, "fleet_status returns the raw GetSystemStatusResponse")
		assert.Equal(t, uint64(3), resp.Total)
	})
}

// TestServerAttachesBearerTokenFromRequest proves the other half of the
// blocker fix end to end through the actual Server: given a Client wired
// through the real auth interceptor, a tools/call arriving over HTTP with a
// valid Authorization header succeeds, which is only possible if Handler's
// serveHTTP put that same token into the context it hands to Invoker.Call
// (via WithBearerToken) rather than the token evaporating once the MCP
// layer's own authentication step consumes it.
func TestServerAttachesBearerTokenFromRequest(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	aud := &recordingAuditor{}
	client := authEnabledConnectClient(t, aud)
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)

	srv, err := NewServer(ServerConfig{
		Registry:      r,
		Authenticator: mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer),
		Confirmer:     NewConfirmer(store, time.Minute),
		Auditor:       aud,
		Cache:         store,
		Secret:        testSecret,
		PublicURL:     "https://paprika.example",
		Client:        client,
	})
	require.NoError(t, err)

	token := bearerFor(t, ScopeRead)
	body := doJSONRPC(t, srv,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fleet_status","arguments":{}}}`,
		token)

	var out struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				// protojson.Marshal renders uint64 fields as JSON strings
				// (the proto3 canonical JSON mapping keeps 64-bit integers
				// as strings for interoperability with JS number types),
				// so this deliberately unmarshals into a string, not a
				// uint64.
				Total string `json:"total"`
			} `json:"structuredContent"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(body, &out))
	require.Nil(t, out.Error, "body: %s", string(body))
	require.False(t, out.Result.IsError, "body: %s", string(body))
	assert.Equal(t, "3", out.Result.StructuredContent.Total)

	// The token must never appear verbatim anywhere in the wire response —
	// see the no-leak assertions below for the fuller treatment of this.
	assert.NotContains(t, string(body), token)
}

// --- The token must never leak into logs or error messages ---
//
// transport.go's RoundTrip only ever uses the token to set a header on a
// cloned request; it is never interpolated into a returned error, a log
// line, or any string this package builds. These tests make that guarantee
// concrete rather than relying on code review alone: they force every error
// path a token could plausibly leak through and assert its exact value is
// absent from what came back.
func TestBearerTokenDoesNotLeakIntoErrorsOrResponses(t *testing.T) {
	const canary = "canary-secret-token-must-not-leak-anywhere"

	t.Run("transport cancellation error", func(t *testing.T) {
		block := make(chan struct{})
		t.Cleanup(func() { close(block) })
		blocking := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			<-block
		})
		rt := NewInProcessTransport(blocking)

		ctx, cancel := context.WithCancel(WithBearerToken(context.Background(), canary))
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://in-process/x", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+canary)

		cancel()
		resp, rtErr := rt.RoundTrip(req)
		if resp != nil {
			defer func() { _ = resp.Body.Close() }()
		}
		require.Error(t, rtErr)
		assert.NotContains(t, rtErr.Error(), canary)
	})

	t.Run("unauthenticated invoker error", func(t *testing.T) {
		r := NewRegistry()
		require.NoError(t, RegisterReadTools(r))
		client := authEnabledConnectClient(t, &recordingAuditor{})
		store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
		require.NoError(t, err)
		inv := NewInvoker(r, client, NewConfirmer(store, time.Minute), &recordingAuditor{})
		principal := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

		// A malformed / garbage token: still forwarded as a header by
		// RoundTrip, still rejected by the real auth interceptor, and its
		// value must not surface in the resulting error.
		ctx := WithBearerToken(context.Background(), canary)
		_, callErr := inv.Call(ctx, principal, "fleet_status", json.RawMessage(`{}`))
		require.Error(t, callErr)
		assert.NotContains(t, callErr.Error(), canary)
	})

	t.Run("401 response carries no token", func(t *testing.T) {
		srv := newTestServer(t)
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+canary)
		srv.Handler().ServeHTTP(rec, req)

		assert.NotContains(t, rec.Body.String(), canary)
		for _, values := range rec.Header() {
			for _, v := range values {
				assert.NotContains(t, v, canary)
			}
		}
	})
}

// --- Error-mapping unit tests (server_test.go owns these directly, since
// ErrToolNotFound is not reachable through the SDK's own HTTP dispatch —
// see mapInvokeError's doc comment) ---

func TestMapInvokeErrorTranslatesEachInvokerError(t *testing.T) {
	srv := newTestServer(t)

	t.Run("ErrScopeDenied names the missing scope", func(t *testing.T) {
		result, err := srv.mapInvokeError("fleet_status", ErrScopeDenied)
		require.Nil(t, result)
		require.Error(t, err)
		var wireErr *sdkjsonrpc.Error
		require.ErrorAs(t, err, &wireErr)
		assert.EqualValues(t, codeScopeDenied, wireErr.Code)
		assert.Contains(t, wireErr.Message, string(ScopeRead))
		assert.Contains(t, wireErr.Message, "fleet_status")
	})

	t.Run("ErrToolNotFound becomes method-not-found", func(t *testing.T) {
		result, err := srv.mapInvokeError("no_such_tool", ErrToolNotFound)
		require.Nil(t, result)
		require.Error(t, err)
		var wireErr *sdkjsonrpc.Error
		require.ErrorAs(t, err, &wireErr)
		assert.EqualValues(t, sdkjsonrpc.CodeMethodNotFound, wireErr.Code)
	})

	t.Run("ConfirmationRequiredError becomes a successful result", func(t *testing.T) {
		confirmErr := &ConfirmationRequiredError{
			Tool: "rollback_release", Token: "tok-123", Preview: "About to roll back",
		}
		result, err := srv.mapInvokeError("rollback_release", confirmErr)
		require.NoError(t, err, "a confirmation prompt is a successful result, not a protocol error")
		require.NotNil(t, result)
		require.False(t, result.IsError)

		data, marshalErr := json.Marshal(result.StructuredContent)
		require.NoError(t, marshalErr)
		assert.Contains(t, string(data), "tok-123")
	})

	t.Run("unknown error passes through unchanged", func(t *testing.T) {
		sentinel := assert.AnError
		_, err := srv.mapInvokeError("fleet_status", sentinel)
		assert.Same(t, sentinel, err)
	})
}

// --- Smoke coverage for the cache/redirect test helpers this task adds for
// Task 14's OAuth tests to build on ---

func TestNewTestServerWithCacheExposesTheServersOwnStore(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	require.NotNil(t, store)
	assert.Same(t, srv.cache, store)
}

func TestNewTestServerWithRedirectsConfiguresExactMatchAllowlist(t *testing.T) {
	redirects := []string{"https://client.example/callback"}
	srv := newTestServerWithRedirects(t, redirects)
	assert.Equal(t, "test", srv.clientID)
	assert.Equal(t, redirects, srv.redirectURIs)
}
