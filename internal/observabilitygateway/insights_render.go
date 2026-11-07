package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	dashboardRenderTimeout = 24 * time.Second
	dashboardRenderMaxPNG  = 4 << 20
)

const dashboardRenderSchema = `{"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":` + insightsIDSchema + `,"width":{"enum":[390,768,1512],"type":"integer"},"theme":{"enum":["dark","light"],"type":"string"},"focus_widget":` + insightsIDSchema + `}}`

type dashboardPreviewRenderer struct {
	endpoint string
	secret   string
	client   *http.Client
}
type dashboardRenderArgs struct {
	ID          string `json:"id"`
	Width       int    `json:"width,omitempty"`
	Theme       string `json:"theme,omitempty"`
	FocusWidget string `json:"focus_widget,omitempty"` //nolint:tagliatelle // MCP uses snake_case.
}

// ConfigureDashboardRenderer enables a local, separate Chromium sidecar.
// The URL is deployment configuration, never an MCP input. Loopback-only
// prevents a client-selected destination from receiving human credentials.
//
//nolint:cyclop // Security-sensitive endpoint checks must remain independently explicit.
func (c *InsightsAuthoringClient) ConfigureDashboardRenderer(endpoint, secret string) error {
	if endpoint == "" && secret == "" {
		c.renderer = nil
		return nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" ||
		u.Port() == "" || u.Path != "/render" || u.RawQuery != "" ||
		u.User != nil || u.Fragment != "" || len(secret) < 32 {
		return errors.New("dashboard browser renderer requires http://127.0.0.1:<port>/render and a secret of at least 32 bytes")
	}
	c.renderer = &dashboardPreviewRenderer{endpoint: u.String(), secret: secret,
		client: &http.Client{
			Timeout: dashboardRenderTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	return nil
}

//nolint:cyclop // Validate every independent bound on untrusted MCP arguments.
func parseDashboardRenderArgs(raw json.RawMessage) (dashboardRenderArgs, error) {
	var args dashboardRenderArgs
	if len(raw) == 0 || len(raw) > 2048 {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("browser render arguments are too large"))
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid browser render arguments"))
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) ||
		!insightsDocumentID.MatchString(args.ID) ||
		(args.FocusWidget != "" && !insightsDocumentID.MatchString(args.FocusWidget)) {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid dashboard or widget identifier"))
	}
	if args.Width == 0 {
		args.Width = 1512
	}
	if args.Theme == "" {
		args.Theme = "dark"
	}
	if (args.Width != 390 && args.Width != 768 && args.Width != 1512) ||
		(args.Theme != "dark" && args.Theme != "light") {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("unsupported preview viewport or appearance"))
	}
	return args, nil
}

func insightsRenderDashboardTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{Name: "render_dashboard", Title: "Render Insights dashboard in browser",
		Description: "Read-only browser screenshot of an authorized saved dashboard. Returns image/png alongside the source ETag and viewport. Requires the operator's isolated screenshot worker; no arbitrary URLs and no saved-document mutations.",
		Scope:       mcp.ScopeObserve, InputSchema: json.RawMessage(dashboardRenderSchema),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			args, err := parseDashboardRenderArgs(raw)
			if err != nil {
				return nil, err
			}
			return c.renderDashboard(ctx, args)
		},
	}
}

//nolint:cyclop // Keep caller authorization and image checks explicit.
func (c *InsightsAuthoringClient) renderDashboard(ctx context.Context, args dashboardRenderArgs) (*sdkmcp.CallToolResult, error) {
	if c.renderer == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("dashboard browser renderer is not configured"))
	}
	// The existing Insights GET path validates human read access before the
	// renderer receives any delegated token. No web URL comes from callers.
	doc, err := c.get(ctx, "dashboards", args.ID)
	if err != nil {
		return nil, err
	}
	var details struct {
		Title   string `json:"title"`
		Widgets []struct {
			ID string `json:"id"`
		} `json:"widgets"`
	}
	if json.Unmarshal(doc.Document, &details) != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid saved dashboard"))
	}
	if args.FocusWidget != "" {
		found := false
		for _, widget := range details.Widgets {
			if widget.ID == args.FocusWidget {
				found = true
				break
			}
		}
		if !found {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("widget does not exist in this dashboard"))
		}
	}
	token, err := c.credential(ctx, false)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid renderer request"))
	}
	bounded, cancel := context.WithTimeout(ctx, dashboardRenderTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(bounded, http.MethodPost, c.renderer.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid renderer URL"))
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Paprika-Render-Secret", c.renderer.secret)
	req.Header.Set("X-Paprika-Dashboard-ETag", doc.ETag)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.renderer.client.Do(req) // #nosec G704 -- Operator-configured, fixed loopback-only URL.
	if err != nil {
		return dashboardRenderFailureResult("renderer_transport", 0, 0, nil), nil
	}
	data, err := readDashboardRenderResponse(response)
	if err != nil {
		var failure *dashboardRenderFailure
		if errors.As(err, &failure) {
			return dashboardRenderFailureResult(failure.category, failure.status, failure.upstreamStatus, nil), nil
		}
		return nil, err
	}
	if response.Header.Get("X-Paprika-Dashboard-ETag") != doc.ETag {
		return nil, connect.NewError(connect.CodeAborted, errors.New("dashboard changed during browser capture; render again"))
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return dashboardRenderFailureResult("png_decode_failed", response.StatusCode, 0, nil), nil
	}
	if config.Width != args.Width || config.Height < 1 || config.Height > 12000 {
		return dashboardRenderFailureResult("png_dimensions_mismatch", response.StatusCode, 0, map[string]int{
			"expectedWidth": args.Width, "actualWidth": config.Width, "actualHeight": config.Height,
		}), nil
	}
	return &sdkmcp.CallToolResult{
		StructuredContent: map[string]any{"id": args.ID, "etag": doc.ETag, "width": config.Width, "height": config.Height, "theme": args.Theme, "source": "browser", "mimeType": "image/png"},
		Content: []sdkmcp.Content{
			&sdkmcp.TextContent{Text: fmt.Sprintf("Browser screenshot of %q. Use query_dashboard separately to verify current data and errors.", details.Title)},
			&sdkmcp.ImageContent{Data: data, MIMEType: "image/png"},
		},
	}, nil
}

func readDashboardRenderResponse(response *http.Response) ([]byte, error) {
	data, readErr := io.ReadAll(io.LimitReader(response.Body, dashboardRenderMaxPNG+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		return nil, &dashboardRenderFailure{category: "renderer_response_read", status: response.StatusCode}
	}
	if response.StatusCode == http.StatusConflict {
		return nil, connect.NewError(connect.CodeAborted, errors.New("dashboard changed during browser capture; render again"))
	}
	if response.StatusCode != http.StatusOK {
		return nil, &dashboardRenderFailure{
			category: dashboardRenderFailureCategory(response.Header), status: response.StatusCode,
			upstreamStatus: dashboardRenderUpstreamStatus(response.Header),
		}
	}
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "image/png") {
		return nil, &dashboardRenderFailure{category: "renderer_content_type", status: response.StatusCode}
	}
	if len(data) > dashboardRenderMaxPNG {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard screenshot exceeds 4 MiB"))
	}
	return data, nil
}

type dashboardRenderFailure struct {
	category       string
	status         int
	upstreamStatus int
}

func (*dashboardRenderFailure) Error() string { return "browser screenshot was not produced" }

// Only these worker-defined codes cross the authenticated MCP boundary. Never
// copy worker bodies, arbitrary headers, URLs, or browser exception messages.
var dashboardRenderWorkerFailures = map[string]struct{}{
	"render_failed": {}, "request_invalid": {}, "request_bounds": {}, "render_deadline": {},
	"browser_start": {}, "browser_context": {}, "ui_navigation": {}, "ui_readiness": {},
	"widget_readiness": {}, "widget_error": {}, "focus_unavailable": {},
	"network_error": {}, "redirect_rejected": {}, "insights_http": {}, "query_error": {},
	"script_error": {}, "revision_conflict": {}, "screenshot_bounds": {}, "screenshot_failed": {},
}

func dashboardRenderFailureCategory(headers http.Header) string {
	values := headers.Values("X-Paprika-Render-Failure")
	if len(values) == 1 {
		if _, allowed := dashboardRenderWorkerFailures[values[0]]; allowed {
			return values[0]
		}
	}
	return "renderer_failure"
}

func dashboardRenderUpstreamStatus(headers http.Header) int {
	values := headers.Values("X-Paprika-Render-Upstream-Status")
	if len(values) != 1 || len(values[0]) != 3 {
		return 0
	}
	status, err := strconv.Atoi(values[0])
	if err != nil || status < 100 || status > 599 {
		return 0
	}
	return status
}

func dashboardRenderFailureResult(category string, status, upstreamStatus int, dimensions map[string]int) *sdkmcp.CallToolResult {
	details := map[string]any{"code": connect.CodeUnavailable.String(), "category": category}
	message := "Dashboard browser capture failed: " + category + "."
	if status != 0 {
		details["httpStatus"] = status
		message += fmt.Sprintf(" Renderer HTTP status: %d.", status)
	}
	if upstreamStatus != 0 {
		details["upstreamStatus"] = upstreamStatus
		message += fmt.Sprintf(" Upstream HTTP status: %d.", upstreamStatus)
	}
	for name, value := range dimensions {
		details[name] = value
	}
	if dimensions != nil {
		message += fmt.Sprintf(" Expected width: %d. PNG dimensions: %d by %d.",
			dimensions["expectedWidth"], dimensions["actualWidth"], dimensions["actualHeight"])
	}
	return &sdkmcp.CallToolResult{
		IsError: true, StructuredContent: map[string]any{"error": details},
		Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: message}},
	}
}
