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
		client: &http.Client{Timeout: dashboardRenderTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
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
		Scope: mcp.ScopeObserve, InputSchema: json.RawMessage(dashboardRenderSchema),
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
		Title string `json:"title"`
		Widgets []struct { ID string `json:"id"` } `json:"widgets"`
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
	req.Header.Set("Content-Type", "application/json")
	response, err := c.renderer.client.Do(req) // #nosec G704 -- Operator-configured, fixed loopback-only URL.
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("browser renderer unavailable"))
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "image/png") {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("browser screenshot was not produced"))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, dashboardRenderMaxPNG+1))
	if err != nil || len(data) > dashboardRenderMaxPNG {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard screenshot exceeds 4 MiB"))
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != args.Width || config.Height < 1 || config.Height > 12000 {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("invalid browser screenshot"))
	}
	return &sdkmcp.CallToolResult{
		StructuredContent: map[string]any{"id": args.ID, "etag": doc.ETag, "width": config.Width, "height": config.Height, "theme": args.Theme, "source": "browser", "mimeType": "image/png"},
		Content: []sdkmcp.Content{
			&sdkmcp.TextContent{Text: fmt.Sprintf("Browser screenshot of %q. Use query_dashboard separately to verify current data and errors.", details.Title)},
			&sdkmcp.ImageContent{Data: data, MIMEType: "image/png"},
		},
	}, nil
}
