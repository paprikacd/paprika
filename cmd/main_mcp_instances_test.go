package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/cache"
)

// Exercise the production handler construction, not just the token verifier:
// two deployments with the same secret and audience must isolate their tokens.
func TestBuildMCPHandlersIsolatesDeploymentIssuers(t *testing.T) {
	ctx := context.Background()
	secret := []byte("shared-test-token-secret-test-token-secret")
	issuers := []string{
		"https://paprika.benebsworth.com",
		"https://paprika.starfleethub.com",
	}
	tokens := make(map[string]string, len(issuers)+1)
	for _, issuer := range append(append([]string{}, issuers...), "") {
		token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
			Subject:  "instance-test-user",
			Audience: mcp.MCPTokenAudience,
			Issuer:   issuer,
			Scope:    string(mcp.ScopeRead),
			TTL:      time.Hour,
			Secret:   secret,
		})
		require.NoError(t, err)
		tokens[issuer] = token
	}

	for _, publicURL := range issuers {
		t.Run(publicURL, func(t *testing.T) {
			store, err := cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
			require.NoError(t, err)
			t.Cleanup(func() { assert.NoError(t, store.Close()) })
			handlers, err := buildMCPHandlers(ctx, &cliConfig{
				MCPEnabled:           true,
				MCPOAuthClientID:     "instance-test-client",
				MCPOAuthRedirectURIs: []string{"http://localhost:8791/callback"},
				MCPPublicURL:         publicURL,
			}, http.NewServeMux(), auth.Config{Enabled: true, TokenSecret: secret}, store, nil)
			require.NoError(t, err)
			mux := http.NewServeMux()
			for _, register := range handlers {
				register(mux)
			}

			for issuer, token := range tokens {
				name := issuer
				if name == "" {
					name = "missing issuer"
				}
				t.Run(name, func(t *testing.T) {
					body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`
					req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/mcp", strings.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Accept", "application/json, text/event-stream")
					req.Header.Set("Authorization", "Bearer "+token)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)

					if issuer == publicURL {
						require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
						assert.Contains(t, rec.Body.String(), `"fleet_status"`)
						return
					}
					assert.Equal(t, http.StatusUnauthorized, rec.Code,
						"a token signed with the same secret and audience must still match this deployment's issuer")
					assert.Contains(t, rec.Header().Get("WWW-Authenticate"), publicURL)
				})
			}
		})
	}
}
