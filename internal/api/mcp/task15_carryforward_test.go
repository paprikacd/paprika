package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This file is new (Task 15) and exists to unit-test package-private
// behaviour changed for Task 15's carry-forwards (CF3, CF5) without
// modifying any of the locked pre-existing test files in this package —
// see task-15-report.md.

// TestNegotiateScopeNilPrincipalDoesNotPanic guards CF3: negotiateScope
// (oauth.go) used to dereference principal.Scopes unconditionally. Nothing
// in this package's own call graph passes it a nil principal today —
// handleAuthorize only calls it after a successful Authenticate — but
// negotiateScope is unexported, directly callable by any future caller in
// this package, and is one of only two places a token's scope claim
// originates (issueTokenPair being the other). A nil principal must be
// rejected the same way every other invalid input here is, not panic.
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

// TestAuthorizeUnknownClientIDAndUnregisteredRedirectAreIndistinguishable
// guards the client_id/redirect_uri half of CF5: before this fix, an
// unknown client_id produced a distinct "unauthorized_client" error while a
// valid client_id paired with an unregistered redirect_uri produced a
// differently worded "invalid_request" error. Both were 400s, but an
// unauthenticated caller could still tell, from the error body alone,
// whether the client_id it guessed was the one wrong thing or whether it
// needed to keep guessing redirect_uri values against a client_id it had
// already confirmed was valid. validateAuthorizeRequest now reports both
// failures identically.
//
// This does not close the second half of CF5 — the fact that a registered
// client_id + redirect_uri pair with no bearer token yields 401 while an
// unregistered pair yields 400. That split is pinned by two locked tests in
// oauth_test.go (TestAuthorizeRejectsUnregisteredRedirectURI requires
// exactly 400; TestAuthorizeAcceptsExactRegisteredRedirectURI requires
// anything but 400 for the same unauthenticated shape) and cannot be
// changed without editing that file, which is outside this task's
// permitted scope — see task-15-report.md's CF5 section.
func TestAuthorizeUnknownClientIDAndUnregisteredRedirectAreIndistinguishable(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	badClientID := httptest.NewRecorder()
	mux.ServeHTTP(badClientID, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=not-registered&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil))

	badRedirect := httptest.NewRecorder()
	mux.ServeHTTP(badRedirect, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape("https://evil.example/callback"), nil))

	require.Equal(t, http.StatusBadRequest, badClientID.Code)
	require.Equal(t, http.StatusBadRequest, badRedirect.Code)
	assert.Equal(t, badClientID.Code, badRedirect.Code)
	assert.Equal(t, badClientID.Body.String(), badRedirect.Body.String(),
		"an unauthenticated caller must not be able to tell a bad client_id from a bad redirect_uri")
}
