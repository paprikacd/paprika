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
		require.True(t, strings.HasPrefix(r.Header.Get("Authorization"), "Bearer "))
		var args dashboardRenderArgs
		require.NoError(t, json.NewDecoder(r.Body).Decode(&args))
		require.Equal(t, "demo", args.ID)
		require.Equal(t, 390, args.Width)
		w.Header().Set("Content-Type", "image/png")
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
