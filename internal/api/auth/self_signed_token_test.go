package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ctxWithBearer returns a context carrying an HTTP request with the given
// token set as a Bearer Authorization header, using the package's existing
// request-in-context mechanism.
func ctxWithBearer(token string) context.Context {
	ctx := context.Background()
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	return WithRequest(ctx, req)
}

func TestIssueTokenWithOptionsEmbedsAudienceAndScope(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Email: "a@b.c", Name: "A",
		Audience: "paprika-mcp", Scope: "paprika:read",
		TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "")
	require.NoError(t, err)
	p, err := auth.Authenticate(ctxWithBearer(token))
	require.NoError(t, err)
	assert.Equal(t, "user-1", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)
}

func TestAudienceMismatchIsRejected(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Audience: "paprika-api",
		Scope: "paprika:read", TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "")
	require.NoError(t, err)
	_, err = auth.Authenticate(ctxWithBearer(token))
	require.Error(t, err, "a console token must not be replayable against MCP")
}

func TestLegacyAudlessTokenRejectedByAudienceAuthenticator(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret) // no aud
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "")
	require.NoError(t, err)
	_, err = auth.Authenticate(ctxWithBearer(legacy))
	require.Error(t, err, "MCP validates aud strictly during migration")
}

func TestLegacyAudlessTokenStillAcceptedByExistingAuthenticator(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret)
	require.NoError(t, err)

	p, err := NewSelfSignedAuthenticator(secret).Authenticate(ctxWithBearer(legacy))
	require.NoError(t, err, "console and CLI tokens must keep working")
	assert.Equal(t, "user-1", p.Subject)
}

func TestIssuerMatchIsAccepted(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Audience: "paprika-mcp", Issuer: "https://paprika.example.com",
		Scope: "paprika:read", TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "https://paprika.example.com")
	require.NoError(t, err)
	p, err := auth.Authenticate(ctxWithBearer(token))
	require.NoError(t, err)
	assert.Equal(t, "user-1", p.Subject)
}

func TestIssuerMismatchIsRejected(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Audience: "paprika-mcp", Issuer: "https://someone-else.example.com",
		Scope: "paprika:read", TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "https://paprika.example.com")
	require.NoError(t, err)
	_, err = auth.Authenticate(ctxWithBearer(token))
	require.Error(t, err, "a token issued by a different issuer must be rejected")
}

func TestAbsentIssuerRejectedWhenIssuerRequired(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Audience: "paprika-mcp", // no Issuer set
		Scope: "paprika:read", TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth, err := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp", "https://paprika.example.com")
	require.NoError(t, err)
	_, err = auth.Authenticate(ctxWithBearer(token))
	require.Error(t, err, "a token with no iss must be rejected when an issuer is required")
}

func TestLegacyTokenStillAcceptedByPlainAuthenticatorWhenIssuerConfiguredElsewhere(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret) // no aud, no iss

	require.NoError(t, err)

	// The plain authenticator never checks iss, regardless of what other
	// authenticators in the process might require.
	p, err := NewSelfSignedAuthenticator(secret).Authenticate(ctxWithBearer(legacy))
	require.NoError(t, err, "console and CLI tokens must keep working")
	assert.Equal(t, "user-1", p.Subject)
}

func TestNewSelfSignedAuthenticatorForAudienceRejectsEmptyAudience(t *testing.T) {
	secret := []byte("test-secret-value")
	_, err := NewSelfSignedAuthenticatorForAudience(secret, "", "")
	require.Error(t, err, "an empty audience must not silently disable the strict check")
}
