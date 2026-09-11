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

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
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

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
	_, err = auth.Authenticate(ctxWithBearer(token))
	require.Error(t, err, "a console token must not be replayable against MCP")
}

func TestLegacyAudlessTokenRejectedByAudienceAuthenticator(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret) // no aud
	require.NoError(t, err)

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
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
