package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type extensionWireResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// These tests exercise the same authenticated Streamable HTTP endpoint used
// by a plugin host, rather than calling metadata or resource helpers directly.
func extensionRPC(t *testing.T, srv *Server, method string, params any, token string) extensionWireResponse {
	t.Helper()
	protocolVersion := "2026-07-28"
	if method == "initialize" {
		protocolVersion = "2025-11-25"
	} else {
		object, ok := params.(map[string]any)
		require.True(t, ok)
		object["_meta"] = map[string]any{
			sdkmcp.MetaKeyProtocolVersion:    protocolVersion,
			sdkmcp.MetaKeyClientInfo:         map[string]any{"name": "plugin-test", "version": "1"},
			sdkmcp.MetaKeyClientCapabilities: map[string]any{},
		}
	}
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Protocol-Version", protocolVersion)
	req.Header.Set("Mcp-Method", method)
	if object, ok := params.(map[string]any); ok {
		if name, ok := object["name"].(string); ok {
			req.Header.Set("Mcp-Name", name)
		}
		if uri, ok := object["uri"].(string); ok {
			req.Header.Set("Mcp-Name", uri)
		}
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	require.Contains(t, []int{http.StatusOK, http.StatusBadRequest}, rec.Code, "body: %s", rec.Body.String())
	var response extensionWireResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	if rec.Code == http.StatusBadRequest {
		require.NotNil(t, response.Error, "HTTP 400 must carry a JSON-RPC error")
	}
	return response
}

func extensionObject(t *testing.T, value any) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	require.True(t, ok, "expected a JSON object, got %T", value)
	return result
}

func extensionArray(t *testing.T, value any) []any {
	t.Helper()
	result, ok := value.([]any)
	require.True(t, ok, "expected a JSON array, got %T", value)
	return result
}

func TestExtensionsDiscoverAndInitializeProvideDisplayIdentity(t *testing.T) {
	srv := newTestServer(t)
	token := bearerFor(t, ScopeRead)
	discovery := extensionRPC(t, srv, "server/discover", map[string]any{}, token)
	require.Nil(t, discovery.Error)
	var result struct {
		Meta         map[string]json.RawMessage `json:"_meta"` //nolint:tagliatelle // MCP reserves the literal _meta wire key.
		Capabilities sdkmcp.ServerCapabilities  `json:"capabilities"`
	}
	require.NoError(t, json.Unmarshal(discovery.Result, &result))
	var identity sdkmcp.Implementation
	require.NoError(t, json.Unmarshal(result.Meta["io.modelcontextprotocol/serverInfo"], &identity))
	assert.Equal(t, "Paprika", identity.Title)
	require.NotEmpty(t, identity.Icons)
	assert.Equal(t, "image/svg+xml", identity.Icons[0].MIMEType)
	assert.NotNil(t, result.Capabilities.Tools)
	require.NotNil(t, result.Capabilities.Resources)
	assert.False(t, result.Capabilities.Resources.Subscribe, "stateless resources must not advertise subscriptions")

	initialize := extensionRPC(t, srv, "initialize", map[string]any{
		"protocolVersion": "2025-11-25", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "plugin-test", "version": "1"},
	}, token)
	require.Nil(t, initialize.Error)
	var legacy struct {
		ServerInfo sdkmcp.Implementation `json:"serverInfo"`
	}
	require.NoError(t, json.Unmarshal(initialize.Result, &legacy))
	assert.Equal(t, identity.Title, legacy.ServerInfo.Title)
	assert.Equal(t, identity.Icons, legacy.ServerInfo.Icons)
}

func TestExtensionsToolsAdvertiseEntrypointsAndMentionSearch(t *testing.T) {
	response := extensionRPC(t, newTestServer(t), "tools/list", map[string]any{}, bearerFor(t, ScopeRead))
	require.Nil(t, response.Error)
	var result struct {
		Tools []*sdkmcp.Tool `json:"tools"`
	}
	require.NoError(t, json.Unmarshal(response.Result, &result))
	byName := make(map[string]*sdkmcp.Tool, len(result.Tools))
	for _, tool := range result.Tools {
		byName[tool.Name] = tool
	}
	opener := byName["open_fleet"]
	require.NotNil(t, opener)
	assert.Equal(t, "Paprika", opener.Title, "global navigation uses the opener title")
	require.NotEmpty(t, opener.Icons)
	require.NotNil(t, opener.Annotations)
	assert.True(t, opener.Annotations.ReadOnlyHint)
	assert.Equal(t, "ui://paprika/console", extensionObject(t, opener.Meta["ui"])["resourceUri"])
	entrypoints := extensionArray(t, extensionObject(t, opener.Meta["openai/ui"])["entrypoints"])
	types := make([]string, 0, len(entrypoints))
	for _, entry := range entrypoints {
		kind, ok := extensionObject(t, entry)["type"].(string)
		require.True(t, ok)
		types = append(types, kind)
	}
	assert.ElementsMatch(t, []string{"global", "thread"}, types)

	mentions := byName["search_mentions"]
	require.NotNil(t, mentions)
	require.NotNil(t, mentions.Annotations)
	assert.True(t, mentions.Annotations.ReadOnlyHint)
	assert.Equal(t, []any{"app"}, extensionObject(t, mentions.Meta["ui"])["visibility"])
	extensions := extensionObject(t, mentions.Meta["openai/extensions"])
	assert.Equal(t, map[string]any{}, extensions["mentions/search"])
	require.NotNil(t, mentions.OutputSchema, "hosts use the mentions result schema")
	assert.Equal(t, []any{"query"}, extensionObject(t, mentions.InputSchema)["required"])
}

func TestExtensionsConsoleResourceAndApplicationTemplate(t *testing.T) {
	srv := newTestServer(t)
	token := bearerFor(t, ScopeRead)
	response := extensionRPC(t, srv, "resources/read", map[string]any{"uri": "ui://paprika/console"}, token)
	require.Nil(t, response.Error)
	var resource sdkmcp.ReadResourceResult
	require.NoError(t, json.Unmarshal(response.Result, &resource))
	require.Len(t, resource.Contents, 1)
	content := resource.Contents[0]
	assert.Equal(t, "ui://paprika/console", content.URI)
	assert.Equal(t, "text/html;profile=mcp-app", content.MIMEType)
	assert.Contains(t, content.Text, "<!doctype html>")
	assert.Contains(t, content.Text, "Paprika")
	assert.NotContains(t, content.Text, "<script src=", "the resource must contain its script bundle")
	meta := extensionObject(t, content.Meta["openai/ui"])
	assert.Equal(t, "fullscreen", meta["preferredDisplayMode"])
	assert.Equal(t, []any{"fullscreen"}, meta["availableDisplayModes"])
	assert.Equal(t, "private", resource.CacheScope)
	assert.Zero(t, resource.TTLMs)
	var legacy extensionWireResponse
	require.NoError(t, json.Unmarshal(doJSONRPC(t, srv,
		`{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://paprika/console"}}`, token), &legacy))
	require.Nil(t, legacy.Error, "ordinary MCP clients retain resource access without OpenAI extensions")
	var legacyResource sdkmcp.ReadResourceResult
	require.NoError(t, json.Unmarshal(legacy.Result, &legacyResource))
	require.Len(t, legacyResource.Contents, 1)
	assert.Equal(t, content.MIMEType, legacyResource.Contents[0].MIMEType)
	assert.Equal(t, content.Meta, legacyResource.Contents[0].Meta)

	response = extensionRPC(t, srv, "resources/templates/list", map[string]any{}, token)
	require.Nil(t, response.Error)
	var templates sdkmcp.ListResourceTemplatesResult
	require.NoError(t, json.Unmarshal(response.Result, &templates))
	require.Len(t, templates.ResourceTemplates, 1)
	assert.Equal(t, "paprika://applications/{namespace}/{name}", templates.ResourceTemplates[0].URITemplate)
}

// extensionFixtureService represents an already project-filtered console API.
// Its auth interceptor is real, so losing the acting user's internal credential
// makes the opener, mentions, and resource read fail before these RPC methods.
type extensionFixtureService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	applications []*v1.ApplicationSummary
	query        *v1.QueryApplicationsRequest
	application  *v1.GetApplicationRequest
	principal    string
	calls        int
	deny         bool
}

func (s *extensionFixtureService) observe(ctx context.Context) {
	s.calls++
	if principal := auth.PrincipalFromContext(ctx); principal != nil {
		s.principal = principal.Subject
	}
}

func (s *extensionFixtureService) GetSystemStatus(ctx context.Context, _ *connect.Request[v1.GetSystemStatusRequest]) (*connect.Response[v1.GetSystemStatusResponse], error) {
	s.observe(ctx)
	return connect.NewResponse(&v1.GetSystemStatusResponse{Total: uint64(len(s.applications))}), nil
}

func (s *extensionFixtureService) QueryApplications(ctx context.Context, req *connect.Request[v1.QueryApplicationsRequest]) (*connect.Response[v1.QueryApplicationsResponse], error) {
	s.observe(ctx)
	s.query = req.Msg
	if s.deny {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("project access denied"))
	}
	return connect.NewResponse(&v1.QueryApplicationsResponse{Applications: s.applications}), nil
}

func (s *extensionFixtureService) GetApplication(ctx context.Context, req *connect.Request[v1.GetApplicationRequest]) (*connect.Response[v1.GetApplicationResponse], error) {
	s.observe(ctx)
	s.application = req.Msg
	if s.deny {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("project access denied"))
	}
	return connect.NewResponse(&v1.GetApplicationResponse{Application: &v1.Application{
		Name: req.Msg.Name, Namespace: req.Msg.Namespace, Health: "Healthy", Phase: "Healthy", Synced: true,
	}}), nil
}

func (s *extensionFixtureService) GetResourceTreeDetailed(ctx context.Context, _ *connect.Request[v1.GetResourceTreeDetailedRequest]) (*connect.Response[v1.GetResourceTreeDetailedResponse], error) {
	s.observe(ctx)
	return connect.NewResponse(&v1.GetResourceTreeDetailedResponse{}), nil
}

func extensionFixtureServer(t *testing.T, svc *extensionFixtureService) *Server {
	t.Helper()
	srv := newTestServer(t)
	authInterceptor, err := auth.Interceptor(context.Background(), auth.Config{
		Enabled: true, TokenSecret: testSecret,
		RBACRules: []auth.RBACRule{{
			Subjects: []string{"test-user"}, Actions: []string{"read"},
			Resources: []string{"*"}, Namespaces: []string{"team-a"},
		}},
	}, nil)
	require.NoError(t, err)
	_, handler := v1connect.NewPaprikaServiceHandler(svc, connect.WithInterceptors(authInterceptor))
	client := v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")
	srv.invoker = NewInvoker(srv.registry, client, nil, nil)
	return srv
}

func TestExtensionsOpenFleetAcceptsEmptyArgumentsAndPreservesIdentity(t *testing.T) {
	svc := &extensionFixtureService{applications: []*v1.ApplicationSummary{
		{Identity: &v1.FleetObjectKey{Name: "web", Namespace: "team-a"}},
	}}
	response := extensionRPC(t, extensionFixtureServer(t, svc), "tools/call", map[string]any{
		"name": "open_fleet", "arguments": map[string]any{},
	}, bearerFor(t, ScopeRead))
	require.Nil(t, response.Error)
	var result struct {
		IsError           bool                       `json:"isError"`
		StructuredContent map[string]json.RawMessage `json:"structuredContent"`
	}
	require.NoError(t, json.Unmarshal(response.Result, &result))
	assert.False(t, result.IsError)
	require.NotEmpty(t, result.StructuredContent["fleet"])
	require.NotEmpty(t, result.StructuredContent["applications"])
	var observedAt string
	require.NoError(t, json.Unmarshal(result.StructuredContent["observedAt"], &observedAt))
	_, err := time.Parse(time.RFC3339, observedAt)
	require.NoError(t, err)
	assert.Equal(t, "test-user", svc.principal)
	require.NotNil(t, svc.query)
	assert.Nil(t, svc.query.Filter, "opening without a namespace must leave the fleet filter absent")
}

func TestExtensionsMentionsAreBoundedAuthorizedResourceLinks(t *testing.T) {
	svc := &extensionFixtureService{}
	for i := 0; i < 25; i++ {
		svc.applications = append(svc.applications, &v1.ApplicationSummary{
			Identity: &v1.FleetObjectKey{Name: fmt.Sprintf("web-%02d", i), Namespace: "team-a"},
		})
	}
	srv := extensionFixtureServer(t, svc)
	response := extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "search_mentions", "arguments": map[string]any{"query": "web"},
	}, bearerFor(t, ScopeRead))
	require.Nil(t, response.Error)
	var result struct {
		StructuredContent struct {
			Items []struct {
				Type  string `json:"type"`
				URI   string `json:"uri"`
				Name  string `json:"name"`
				Title string `json:"title"`
			} `json:"items"`
		} `json:"structuredContent"`
	}
	require.NoError(t, json.Unmarshal(response.Result, &result))
	require.Len(t, result.StructuredContent.Items, 20, "bound the result even if the backend returns too many applications")
	for _, item := range result.StructuredContent.Items {
		assert.Equal(t, "resource_link", item.Type)
		assert.Contains(t, item.URI, "paprika://applications/team-a/web-")
		assert.NotEmpty(t, item.Name)
		assert.NotEmpty(t, item.Title)
	}
	require.NotNil(t, svc.query)
	assert.Equal(t, "web", svc.query.Search)
	assert.Equal(t, "test-user", svc.principal)
	assert.LessOrEqual(t, svc.query.PageSize, uint32(20))

	svc.applications = nil
	response = extensionRPC(t, srv, "tools/call", map[string]any{
		"name": "search_mentions", "arguments": map[string]any{"query": ""},
	}, bearerFor(t, ScopeRead))
	require.Nil(t, response.Error)
	var empty map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(response.Result, &empty))
	assert.Contains(t, string(empty["structuredContent"]), `"items":[]`)
}

func TestExtensionsResourcesRequireReadScopeAndStrictApplicationURIs(t *testing.T) {
	svc := &extensionFixtureService{}
	srv := extensionFixtureServer(t, svc)
	for _, uri := range []string{"ui://paprika/console", "paprika://applications/team-a/web"} {
		t.Run("scope "+uri, func(t *testing.T) {
			response := extensionRPC(t, srv, "resources/read", map[string]any{"uri": uri}, bearerFor(t, ScopeWrite))
			require.NotNil(t, response.Error, "write-only access must not grant resource reads")
			assert.Zero(t, svc.calls)
		})
	}
	for _, uri := range []string{
		"https://example.com/app", "file:///etc/passwd", "paprika://other/team-a/web",
		"paprika://applications/team-a", "paprika://applications/team-a/web/extra",
		"paprika://applications/team-a/web?secret=x", "paprika://applications/team-a/web#fragment",
		"paprika://user@applications/team-a/web", "paprika://applications/team-a/..",
		"paprika://applications/team-a/UPPER", "paprika://applications/team-a/a%2Fb",
		"paprika://applications/team-a//web",
	} {
		t.Run(uri, func(t *testing.T) {
			response := extensionRPC(t, srv, "resources/read", map[string]any{"uri": uri}, bearerFor(t, ScopeRead))
			require.NotNil(t, response.Error)
			assert.Zero(t, svc.calls, "an invalid resource URI must never reach the console API")
		})
	}
}

func TestExtensionsApplicationResourcePreservesIdentityAndBackendAuthorization(t *testing.T) {
	svc := &extensionFixtureService{}
	srv := extensionFixtureServer(t, svc)
	const uri = "paprika://applications/team-a/web"
	response := extensionRPC(t, srv, "resources/read", map[string]any{"uri": uri}, bearerFor(t, ScopeRead))
	require.Nil(t, response.Error, "backend calls=%d, requested application=%v", svc.calls, svc.application)
	var result sdkmcp.ReadResourceResult
	require.NoError(t, json.Unmarshal(response.Result, &result))
	require.Len(t, result.Contents, 1)
	assert.Equal(t, uri, result.Contents[0].URI)
	assert.Equal(t, "application/json", result.Contents[0].MIMEType)
	assert.Contains(t, result.Contents[0].Text, "Healthy")
	assert.Equal(t, "private", result.CacheScope)
	assert.Zero(t, result.TTLMs, "app health must be immediately stale")
	require.NotNil(t, svc.application)
	assert.Equal(t, "team-a", svc.application.Namespace)
	assert.Equal(t, "web", svc.application.Name)
	assert.Equal(t, "test-user", svc.principal)
	calls := svc.calls
	response = extensionRPC(t, srv, "resources/read", map[string]any{
		"uri": "paprika://applications/team-b/web",
	}, bearerFor(t, ScopeRead))
	require.NotNil(t, response.Error, "console RBAC must still gate resource reads")
	assert.Equal(t, calls, svc.calls, "the real RBAC interceptor must reject before the application handler")
	assert.Empty(t, response.Result)

	svc.deny = true
	response = extensionRPC(t, srv, "resources/read", map[string]any{"uri": uri}, bearerFor(t, ScopeRead))
	require.NotNil(t, response.Error, "resource reads must preserve console authorization failures")
	assert.Empty(t, response.Result, "denial must not produce a health snapshot")
}

func TestExtensionsToolsRequireReadScopeBeforeConsoleCalls(t *testing.T) {
	svc := &extensionFixtureService{}
	srv := extensionFixtureServer(t, svc)
	for _, name := range []string{"open_fleet", "search_mentions"} {
		t.Run(name, func(t *testing.T) {
			arguments := map[string]any{}
			if name == "search_mentions" {
				arguments["query"] = "web"
			}
			response := extensionRPC(t, srv, "tools/call", map[string]any{
				"name": name, "arguments": arguments,
			}, bearerFor(t, ScopeWrite))
			require.NotNil(t, response.Error)
			assert.Zero(t, svc.calls)
		})
	}
}

func TestExtensionsMentionSearchRejectsInvalidQueriesBeforeConsoleCalls(t *testing.T) {
	svc := &extensionFixtureService{}
	srv := extensionFixtureServer(t, svc)
	for _, arguments := range []map[string]any{
		{}, {"query": true}, {"query": strings.Repeat("x", 257)},
	} {
		response := extensionRPC(t, srv, "tools/call", map[string]any{
			"name": "search_mentions", "arguments": arguments,
		}, bearerFor(t, ScopeRead))
		// Invalid tool arguments may be reported as a JSON-RPC error or an
		// isError tool result. Either must happen before a backend request.
		if response.Error == nil {
			var result sdkmcp.CallToolResult
			require.NoError(t, json.Unmarshal(response.Result, &result))
			assert.True(t, result.IsError)
		}
		assert.Zero(t, svc.calls)
	}
}
