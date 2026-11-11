package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
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

// renderEnvelope is the worker's JSON response: the base64 PNG, the visual checks and timings.
func renderEnvelope(t *testing.T, png []byte, checks string) string {
	t.Helper()
	body := `{"timings":{"readyMs":120,"probeMs":3,"renderMs":480},"checks":` + checks
	if png != nil {
		body += `,"png":"` + base64.StdEncoding.EncodeToString(png) + `"`
	}
	return body + `}`
}

func renderFixtureClient(t *testing.T, rendererHandler http.HandlerFunc) *InsightsAuthoringClient {
	t.Helper()
	renderer := httptest.NewServer(rendererHandler)
	t.Cleanup(renderer.Close)
	service := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"`+strings.Repeat("a", 64)+`"`)
		_, _ = w.Write([]byte(`{"id":"demo","title":"Demo","widgets":[{"id":"panel"},{"id":"other"}]}`))
	})
	c := &InsightsAuthoringClient{
		client: &http.Client{Transport: mcp.NewInProcessTransport(service)},
		secret: []byte(strings.Repeat("k", 32)), publicURL: "https://paprika.example.com",
	}
	require.NoError(t, c.ConfigureDashboardRenderer(renderer.URL+"/render", strings.Repeat("s", 32)))
	return c
}

func operatorContext(t *testing.T) context.Context {
	t.Helper()
	return auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "operator", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}})
}

func mustPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	require.NoError(t, png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, width, height))))
	return buffer.Bytes()
}

func textOf(t *testing.T, result *sdkmcp.CallToolResult) string {
	t.Helper()
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok, "the first content item is the text summary")
	return text.Text
}

func checkReportOf(t *testing.T, structured any) *insightsv1.CheckReport {
	t.Helper()
	content, ok := structured.(map[string]any)
	require.True(t, ok)
	raw, ok := content["checks"].(json.RawMessage)
	require.True(t, ok, "checks must be the CheckReport wire form")
	var report insightsv1.CheckReport
	require.NoError(t, checkwire.Unmarshal(raw, &report))
	return &report
}

func TestDashboardRenderChecksOnlyIsArgumentChecked(t *testing.T) {
	valid, err := parseDashboardRenderArgs(json.RawMessage(`{"id":"demo","checks_only":true}`))
	require.NoError(t, err)
	require.True(t, valid.ChecksOnly)
	_, err = parseDashboardRenderArgs(json.RawMessage(`{"id":"demo","checks_only":true,"focus_widget":"panel"}`))
	require.Error(t, err, "checks_only captures no image, so it cannot focus a widget")
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestDashboardRenderReturnsVisualFindingsWithTheImage(t *testing.T) {
	var sawAccept string
	c := renderFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		sawAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write([]byte(renderEnvelope(t, mustPNG(t, 390, 200), `{"issues":[`+
			`{"ruleId":"visual.clipped-text","severity":"SEVERITY_ERROR","source":"SOURCE_VISUAL","widgetId":"panel","message":"A metric value or its unit is cut off.","fix":"Widen the widget."},`+
			`{"ruleId":"visual.empty-plot","severity":"SEVERITY_WARNING","source":"SOURCE_VISUAL","widgetId":"removed-widget","message":"Chart area has data but nothing is drawn.","fix":"Check the series options."},`+
			`{"ruleId":"visual.made-up","severity":"SEVERITY_ERROR","source":"SOURCE_VISUAL","widgetId":"panel","message":"x","fix":"y"},`+
			`{"ruleId":"schema.widget.layout","severity":"SEVERITY_ERROR","source":"SOURCE_SCHEMA","widgetId":"panel","message":"x","fix":"y"}`+
			`],"total":2,"truncated":false}`)))
	})
	result, err := c.renderDashboard(operatorContext(t), dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark"})
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, "application/json", sawAccept, "the gateway asks the worker for the JSON envelope")
	require.Len(t, result.Content, 2)
	_, ok := result.Content[1].(*sdkmcp.ImageContent)
	require.True(t, ok, "the screenshot stays in the result")

	report := checkReportOf(t, result.StructuredContent)
	require.Len(t, report.GetIssues(), 2, "non-visual and unknown rules are dropped")
	require.Equal(t, "visual.clipped-text", report.GetIssues()[0].GetRuleId())
	require.Equal(t, insightsv1.Source_SOURCE_VISUAL, report.GetIssues()[0].GetSource())
	require.Equal(t, "/widgets/0", report.GetIssues()[0].GetPointer(), "a widget finding points at its document widget")
	require.Empty(t, report.GetIssues()[1].GetWidgetId(), "a widget that is not in the document is not named")
	require.Empty(t, report.GetIssues()[1].GetPointer())
	require.Equal(t, uint32(2), report.GetTotal())
	require.False(t, report.GetTruncated())

	text := textOf(t, result)
	require.Contains(t, text, "1 error(s), 1 warning(s)")
	require.Contains(t, text, "ERROR visual.clipped-text on widget panel")
	require.Contains(t, text, "Fix: Widen the widget.")
	require.NotContains(t, text, "Bearer")

	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	require.Equal(t, 390, content["width"])
	require.Equal(t, 200, content["height"])
	require.Equal(t, dashboardRenderTimings{ReadyMs: 120, ProbeMs: 3, RenderMs: 480}, content["timings"])
}

func TestDashboardRenderChecksOnlyReturnsFindingsWithoutAnImage(t *testing.T) {
	var sentChecksOnly bool
	c := renderFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		var args dashboardRenderArgs
		require.NoError(t, json.NewDecoder(r.Body).Decode(&args))
		sentChecksOnly = args.ChecksOnly
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write([]byte(renderEnvelope(t, nil, `{"issues":[{"ruleId":"visual.internal-scroll","severity":"SEVERITY_WARNING","source":"SOURCE_VISUAL","widgetId":"other","message":"Widget body scrolls vertically inside its tile.","fix":"Increase layout.h."}],"total":1,"truncated":false}`)))
	})
	result, err := c.renderDashboard(operatorContext(t), dashboardRenderArgs{ID: "demo", Width: 1512, Theme: "dark", ChecksOnly: true})
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.True(t, sentChecksOnly, "checks_only reaches the worker")
	require.Len(t, result.Content, 1, "no image content for checks_only")
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	require.Equal(t, true, content["checksOnly"])
	require.NotContains(t, content, "mimeType")
	require.NotContains(t, content, "height")
	report := checkReportOf(t, result.StructuredContent)
	require.Equal(t, "/widgets/1", report.GetIssues()[0].GetPointer())
	require.Contains(t, textOf(t, result), "WARNING visual.internal-scroll on widget other")
}

func TestDashboardRenderBoundsVisualFindings(t *testing.T) {
	issues := make([]string, 0, 40)
	for i := range 40 {
		issues = append(issues, fmt.Sprintf(`{"ruleId":"visual.clipped-text","severity":"SEVERITY_WARNING","source":"SOURCE_VISUAL","widgetId":"panel","message":"Text is cut off inside its widget.","fix":"Widen it %d."}`, i))
	}
	c := renderFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write([]byte(renderEnvelope(t, mustPNG(t, 1512, 300), `{"issues":[`+strings.Join(issues, ",")+`],"total":40,"truncated":false}`)))
	})
	result, err := c.renderDashboard(operatorContext(t), dashboardRenderArgs{ID: "demo", Width: 1512, Theme: "dark"})
	require.NoError(t, err)
	report := checkReportOf(t, result.StructuredContent)
	require.Len(t, report.GetIssues(), checkwire.MaxIssues)
	require.Equal(t, uint32(40), report.GetTotal())
	require.True(t, report.GetTruncated(), "findings beyond the bound are counted and marked truncated")
	text := textOf(t, result)
	require.Contains(t, text, "more finding(s) in checks")
	require.Less(t, len(text), 4096, "the text summary is bounded")
}

func TestDashboardRenderLegacyPNGRendererIsNotReportedAsClean(t *testing.T) {
	var imageBytes = mustPNG(t, 390, 200)
	c := renderFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write(imageBytes)
	})
	result, err := c.renderDashboard(operatorContext(t), dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark"})
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Len(t, result.Content, 2)
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	require.NotContains(t, content, "checks", "a renderer that ran no checks must not report a clean report")
	require.NotContains(t, content, "timings")
	require.Contains(t, textOf(t, result), "not run by this renderer version")
}

func TestDashboardRenderChecksOnlyRequiresTheCheckEnvelope(t *testing.T) {
	c := renderFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Paprika-Dashboard-ETag", r.Header.Get("X-Paprika-Dashboard-ETag"))
		_, _ = w.Write(mustPNG(t, 390, 200))
	})
	result, err := c.renderDashboard(operatorContext(t), dashboardRenderArgs{ID: "demo", Width: 390, Theme: "dark", ChecksOnly: true})
	require.NoError(t, err)
	require.True(t, result.IsError)
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	details, ok := content["error"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "renderer_content_type", details["category"], "a PNG-only renderer cannot answer checks_only")
}
