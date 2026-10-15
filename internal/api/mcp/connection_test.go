package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func connectionResult(t *testing.T, response extensionWireResponse) ConnectionInfo {
	t.Helper()
	require.Nil(t, response.Error)
	var result struct {
		Connection ConnectionInfo `json:"structuredContent"`
		IsError    bool           `json:"isError"`
	}
	require.NoError(t, json.Unmarshal(response.Result, &result))
	require.False(t, result.IsError)
	return result.Connection
}

func TestGetConnectionReportsOnlyActingInstanceAndScopes(t *testing.T) {
	srv := extensionFixtureServer(t, &extensionFixtureService{})
	srv.publicURL = "https://paprika.starfleethub.com"
	response := extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "get_connection", "arguments": map[string]any{},
	}, bearerFor(t, ScopeRead))
	info := connectionResult(t, response)
	assert.Equal(t, "https://paprika.starfleethub.com/mcp", info.Endpoint)
	assert.Equal(t, "https://paprika.starfleethub.com", info.Origin)
	assert.Equal(t, "paprika.starfleethub.com", info.Name)
	assert.Equal(t, []string{"paprika:read"}, info.Scopes)
	assert.NotEmpty(t, info.Server.Version)
	assert.Equal(t, ConnectionAccount{Name: "Test", Email: "test@example.com"}, info.Account)
	assert.NotContains(t, string(response.Result), "test-user", "internal provider subjects are not display labels")

	// A saved UI destination or model argument cannot change the origin or
	// permissions of this request. The schema and handler both reject it.
	response = extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "get_connection", "arguments": map[string]any{"endpoint": "https://elsewhere.example/mcp"},
	}, bearerFor(t, ScopeRead))
	if response.Error == nil {
		var result struct {
			IsError bool `json:"isError"`
		}
		require.NoError(t, json.Unmarshal(response.Result, &result))
		assert.True(t, result.IsError)
	}
}

func TestGetConnectionRequiresReadScope(t *testing.T) {
	response := extensionRPC(t, extensionFixtureServer(t, &extensionFixtureService{}), "tools/call", map[string]any{
		"name": "get_connection", "arguments": map[string]any{},
	}, bearerFor(t, ScopeWrite))
	require.NotNil(t, response.Error)
	assert.Equal(t, int(codeScopeDenied), response.Error.Code)
	assert.NotContains(t, string(response.Result), "endpoint")
}

func TestOpenFleetReturnsSameConnectionAsIdentityTool(t *testing.T) {
	srv := extensionFixtureServer(t, &extensionFixtureService{applications: []*v1.ApplicationSummary{}})
	srv.publicURL = "https://paprika.example"
	token := bearerFor(t, ScopeRead, ScopeWrite)
	info := connectionResult(t, extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "get_connection", "arguments": map[string]any{},
	}, token))
	response := extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "open_fleet", "arguments": map[string]any{},
	}, token)
	require.Nil(t, response.Error)
	var result struct {
		Data struct {
			Connection ConnectionInfo `json:"connection"`
		} `json:"structuredContent"`
	}
	require.NoError(t, json.Unmarshal(response.Result, &result))
	assert.Equal(t, info, result.Data.Connection)
	assert.Equal(t, []string{"paprika:read", "paprika:write"}, info.Scopes)
}

func TestConnectionMetadataUsesValidatedPrincipalDisplayFields(t *testing.T) {
	srv := newTestServer(t)
	info, err := srv.connectionInfo(&auth.Principal{
		Subject: "opaque-provider-subject", Name: "Alex", Email: "alex@example.com",
		Scopes: []string{"paprika:read", "unrelated:scope", "paprika:read"},
	})
	require.NoError(t, err)
	assert.Equal(t, ConnectionAccount{Name: "Alex", Email: "alex@example.com"}, info.Account)
	assert.Equal(t, []string{"paprika:read"}, info.Scopes)
	missing, err := srv.connectionInfo(&auth.Principal{Subject: "opaque-provider-subject"})
	require.NoError(t, err)
	assert.Empty(t, missing.Account,
		"missing optional JWT display fields must not invent an account")
	ctx := context.WithValue(context.Background(), connectionInfoKey{}, info)
	result, err := readGetConnectionTool().Invoke(ctx, nil, json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.Equal(t, info, result)
}
