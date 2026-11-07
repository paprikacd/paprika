package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

func TestDashboardRenderArgumentsBoundedAndExact(t *testing.T) {
	valid, err := parseDashboardRenderArgs(json.RawMessage(`{"id":"demo"}`))
	require.NoError(t, err)
	require.Equal(t, 1512, valid.Width)
	require.Equal(t, "dark", valid.Theme)
	for _, raw := range []string{
		`{"id":"../etc/passwd"}`, `{"id":"demo","width":300}`, `{"id":"demo","theme":"purple"}`,
		`{"id":"demo","url":"http://169.254.169.254"}`,
		`{"id":"demo","focus_widget":"../private"}`, `{"id":"demo"}{"id":"other"}`,
	} {
		_, err := parseDashboardRenderArgs(json.RawMessage(raw))
		require.Error(t, err, raw)
	}
}

func TestDashboardRendererConfigurationIsLoopbackOnly(t *testing.T) {
	c := &InsightsAuthoringClient{}
	secret := strings.Repeat("x", 32)
	require.NoError(t, c.ConfigureDashboardRenderer("", ""))
	require.Nil(t, c.renderer)
	for _, endpoint := range []string{
		"https://paprika.example.com/render",
		"http://169.254.169.254/render",
		"http://127.0.0.1:9081/other",
		"http://127.0.0.1:9081/render?target=http://example.com",
	} {
		require.Error(t, c.ConfigureDashboardRenderer(endpoint, secret), endpoint)
	}
	require.NoError(t, c.ConfigureDashboardRenderer("http://127.0.0.1:9081/render", secret))
	require.NotNil(t, c.renderer)
}

func TestDashboardRenderToolOnlyAdvertisedWhenConfigured(t *testing.T) {
	c := &InsightsAuthoringClient{}
	tools := mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(tools, c, nil))
	_, present := tools.Lookup("render_dashboard")
	require.False(t, present)
	require.NoError(t, c.ConfigureDashboardRenderer("http://127.0.0.1:9081/render", strings.Repeat("x", 32)))
	tools = mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(tools, c, nil))
	tool, present := tools.Lookup("render_dashboard")
	require.True(t, present)
	require.Equal(t, mcp.ScopeObserve, tool.Scope)
}

func TestDashboardRenderEmitsBrowserImageWithoutExposingToken(t *testing.T) {
	var imageBytes bytes.Buffer
	require.NoError(t, png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 390, 200))))
	secret := strings.Repeat("s", 32)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/render", r.URL.Path)
		require.Equal(t, "POST", r.Method)
		require.Equal(t, secret, r.Header.Get("X-Paprika-Render-Secret"))
		require.Equal(t, `"`+strings.Repeat("a", 64)+`"`, r.Header.Get("X-Paprika-Dashboard-ETag"))
		require.True(t, strings.HasPrefix(r.Header.Get("Authorization"), "Bearer "))
		var args dashboardRenderArgs
		require.NoError(t, json.NewDecoder(r.Body).Decode(&args))
		require.Equal(t, "demo", args.ID)
		require.Equal(t, 390, args.Width)
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write(imageBytes.Bytes())
	}))
	defer renderer.Close()
	service := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/insights/dashboards/demo", r.URL.Path)
		require.Equal(t, http.MethodGet, r.Method)
		w.Header().Set("ETag", `"`+strings.Repeat("a", 64)+`"`)
		_, _ = w.Write([]byte(`{"id":"demo","title":"Demo","widgets":[{"id":"panel"}]}`))
	})
	c := &InsightsAuthoringClient{
		client: &http.Client{Transport: mcp.NewInProcessTransport(service)},
		secret: []byte(strings.Repeat("k", 32)), publicURL: "https://paprika.example.com",
	}
	require.NoError(t, c.ConfigureDashboardRenderer(renderer.URL+"/render", secret))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{
		Subject: "operator", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"},
	})
	result, err := c.renderDashboard(ctx, dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark"})
	require.NoError(t, err)
	require.Len(t, result.Content, 2)
	embedded, ok := result.Content[1].(*sdkmcp.ImageContent)
	require.True(t, ok)
	require.Equal(t, "image/png", embedded.MIMEType)
	require.Equal(t, imageBytes.Bytes(), embedded.Data)
	previewText, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.NotContains(t, previewText.Text, "Bearer")
}

func TestDashboardRenderRequiresMatchingCapturedRevision(t *testing.T) {
	var imageBytes bytes.Buffer
	require.NoError(t, png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 390, 200))))
	for _, test := range []struct {
		name         string
		status       int
		responseETag string
	}{
		{name: "missing captured revision", status: http.StatusOK},
		{name: "different captured revision", status: http.StatusOK, responseETag: `"` + strings.Repeat("b", 64) + `"`},
		{name: "worker observed revision conflict", status: http.StatusConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, `"`+strings.Repeat("a", 64)+`"`, r.Header.Get("X-Paprika-Dashboard-ETag"))
				w.Header().Set("Content-Type", "image/png")
				w.Header().Set("X-Paprika-Dashboard-ETag", test.responseETag)
				w.WriteHeader(test.status)
				_, _ = w.Write(imageBytes.Bytes())
			}))
			defer renderer.Close()
			service := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("ETag", `"`+strings.Repeat("a", 64)+`"`)
				_, _ = w.Write([]byte(`{"id":"demo","title":"Demo","widgets":[{"id":"panel"}]}`))
			})
			c := &InsightsAuthoringClient{
				client: &http.Client{Transport: mcp.NewInProcessTransport(service)},
				secret: []byte(strings.Repeat("k", 32)), publicURL: "https://paprika.example.com",
			}
			require.NoError(t, c.ConfigureDashboardRenderer(renderer.URL+"/render", strings.Repeat("s", 32)))
			ctx := auth.WithPrincipal(t.Context(), &auth.Principal{
				Subject: "operator", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"},
			})
			result, err := c.renderDashboard(ctx, dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark"})
			require.Equal(t, connect.CodeAborted, connect.CodeOf(err))
			require.Nil(t, result, "a different or unverified document revision must not be attached to the screenshot")
		})
	}
}

func TestDashboardRenderDoesNotDelegateWhenHumanReadIsDenied(t *testing.T) {
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("renderer must not receive a delegated token when the human cannot read Insights")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer renderer.Close()
	service := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	c := &InsightsAuthoringClient{
		client: &http.Client{Transport: mcp.NewInProcessTransport(service)},
		secret: []byte(strings.Repeat("k", 32)), publicURL: "https://paprika.example.com",
	}
	require.NoError(t, c.ConfigureDashboardRenderer(renderer.URL+"/render", strings.Repeat("s", 32)))
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{
		Subject: "operator", Scopes: []string{"paprika:observe"},
	})
	result, err := c.renderDashboard(ctx, dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark"})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Nil(t, result)
}

func TestDashboardRenderSanitizesWorkerFailures(t *testing.T) {
	const private = "https://private.example/path?token=private-token Bearer private-token"
	for _, test := range []struct {
		name       string
		categories []string
		statuses   []string
		category   string
		upstream   int
	}{
		{name: "upstream rate limit", categories: []string{"insights_http"}, statuses: []string{"429"}, category: "insights_http", upstream: 429},
		{name: "upstream authorization", categories: []string{"insights_http"}, statuses: []string{"403"}, category: "insights_http", upstream: 403},
		{name: "missing diagnostics", category: "renderer_failure"},
		{name: "private header values", categories: []string{private}, statuses: []string{private}, category: "renderer_failure"},
		{name: "duplicate categories", categories: []string{"insights_http", private}, category: "renderer_failure"},
		{name: "oversized category", categories: []string{strings.Repeat("x", 4096)}, category: "renderer_failure"},
		{name: "duplicate statuses", categories: []string{"insights_http"}, statuses: []string{"429", "500"}, category: "insights_http"},
		{name: "negative status", categories: []string{"insights_http"}, statuses: []string{"-99"}, category: "insights_http"},
		{name: "invalid status", categories: []string{"insights_http"}, statuses: []string{"4xx"}, category: "insights_http"},
		{name: "out of range status", categories: []string{"insights_http"}, statuses: []string{"999"}, category: "insights_http"},
	} {
		t.Run(test.name, func(t *testing.T) {
			delegated := make(chan string, 1)
			result, err := invokeRenderFailureFixture(t, func(w http.ResponseWriter, r *http.Request) {
				for _, category := range test.categories {
					w.Header().Add("X-Paprika-Render-Failure", category)
				}
				for _, status := range test.statuses {
					w.Header().Add("X-Paprika-Render-Upstream-Status", status)
				}
				credential := r.Header.Get("Authorization")
				delegated <- credential
				w.Header().Set("Content-Type", "application/octet-stream")
				w.WriteHeader(http.StatusUnprocessableEntity)
				// #nosec G705 -- The hostile test renderer echoes fixture credentials to prove MCP never reflects its body.
				_, _ = w.Write([]byte(private + credential + r.Header.Get("X-Paprika-Render-Secret")))
			})
			require.NoError(t, err, "a safe operational failure must reach the MCP tool result")
			require.True(t, result.IsError)
			content, ok := result.StructuredContent.(map[string]any)
			require.True(t, ok)
			details, ok := content["error"].(map[string]any)
			require.True(t, ok)
			require.Equal(t, "unavailable", details["code"])
			require.Equal(t, test.category, details["category"])
			require.Equal(t, http.StatusUnprocessableEntity, details["httpStatus"])
			if test.upstream == 0 {
				require.NotContains(t, details, "upstreamStatus")
			} else {
				require.Equal(t, test.upstream, details["upstreamStatus"])
			}
			wire, marshalErr := json.Marshal(result)
			require.NoError(t, marshalErr)
			for _, forbidden := range []string{"private.example", "private-token", "Bearer", strings.Repeat("s", 32), <-delegated} {
				require.NotContains(t, string(wire), forbidden)
			}
		})
	}
}

func TestDashboardRenderDistinguishesInvalidPNGAndDimensions(t *testing.T) {
	var wrongWidth bytes.Buffer
	require.NoError(t, png.Encode(&wrongWidth, image.NewRGBA(image.Rect(0, 0, 400, 200))))
	for _, test := range []struct {
		name     string
		data     []byte
		category string
	}{
		{name: "corrupt PNG", data: []byte("https://private.example Bearer private-token"), category: "png_decode_failed"},
		{name: "unexpected capture width", data: wrongWidth.Bytes(), category: "png_dimensions_mismatch"},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := invokeRenderFailureFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "image/png")
				w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
				_, _ = w.Write(test.data)
			})
			require.NoError(t, err)
			require.True(t, result.IsError)
			content, ok := result.StructuredContent.(map[string]any)
			require.True(t, ok)
			details, ok := content["error"].(map[string]any)
			require.True(t, ok)
			require.Equal(t, test.category, details["category"])
			require.Equal(t, http.StatusOK, details["httpStatus"])
			if test.category == "png_dimensions_mismatch" {
				require.Equal(t, 390, details["expectedWidth"])
				require.Equal(t, 400, details["actualWidth"])
				require.Equal(t, 200, details["actualHeight"])
			}
			wire, marshalErr := json.Marshal(result)
			require.NoError(t, marshalErr)
			require.NotContains(t, string(wire), "private.example")
			require.NotContains(t, string(wire), "private-token")
		})
	}
}

func invokeRenderFailureFixture(t *testing.T, rendererHandler http.HandlerFunc) (*sdkmcp.CallToolResult, error) {
	t.Helper()
	renderer := httptest.NewServer(rendererHandler)
	t.Cleanup(renderer.Close)
	service := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"`+strings.Repeat("a", 64)+`"`)
		_, _ = w.Write([]byte(`{"id":"demo","title":"Demo","widgets":[{"id":"panel"}]}`))
	})
	c := &InsightsAuthoringClient{
		client: &http.Client{Transport: mcp.NewInProcessTransport(service)},
		secret: []byte(strings.Repeat("k", 32)), publicURL: "https://paprika.example.com",
	}
	require.NoError(t, c.ConfigureDashboardRenderer(renderer.URL+"/render", strings.Repeat("s", 32)))
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{
		Subject: "operator", Scopes: []string{"paprika:observe"},
	})
	tool := insightsRenderDashboardTool(c)
	value, err := tool.Invoke(ctx, nil, json.RawMessage(`{"id":"demo","width":390,"theme":"dark"}`))
	if err != nil {
		return nil, err
	}
	result, ok := value.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	return result, nil
}
