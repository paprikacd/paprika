package observabilitygateway

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

const (
	dashboardRenderTimeout = 24 * time.Second
	dashboardRenderMaxPNG  = 4 << 20
	// The worker returns the PNG base64-encoded in a JSON envelope with the bounded
	// visual findings and timings, so the body limit is the encoded PNG plus room
	// for at most maxVisualFindings findings.
	dashboardRenderMaxResponse = (dashboardRenderMaxPNG+2)/3*4 + 64<<10
	// maxVisualFindings matches the CheckReport bound used for every check result.
	maxVisualFindings = checkwire.MaxIssues
	// maxVisualTextLines bounds the findings listed in the text summary.
	maxVisualTextLines = 16
)

const dashboardRenderSchema = `{"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":` + insightsIDSchema + `,"width":{"enum":[390,768,1512],"type":"integer"},"theme":{"enum":["dark","light"],"type":"string"},"focus_widget":` + insightsIDSchema + `,"checks_only":{"type":"boolean","description":"Run the visual checks without capturing an image. Cannot be combined with focus_widget."}}}`

// Visual statuses are the structured verdict an agent acts on. failed means at
// least one error finding; passed means the checks ran with no errors; not_run
// means this renderer did not report checks at all.
const (
	visualStatusFailed = "failed"
	visualStatusPassed = "passed"
	visualStatusNotRun = "not_run"
)

// visualText is the gateway's wording for one rule and severity. Worker message and
// fix text is never copied to an agent, and a finding with no entry here is dropped.
type visualText struct{ message, fix string }

var dashboardVisualText = map[string]visualText{
	"visual.widget-error|SEVERITY_ERROR": {
		"Widget shows an error instead of data.",
		"Fix the query, provider or source binding, then render again. A widget error fails the visual check.",
	},
	"visual.page-overflow|SEVERITY_ERROR": {
		"The page scrolls horizontally.",
		"Reduce the widget width, or wrap long text, so the page fits without horizontal scrolling.",
	},
	"visual.clipped-text|SEVERITY_ERROR": {
		"A metric value or its unit is cut off.",
		"Widen the widget (layout.w), give the reading more height (layout.h), or shorten the unit. Stat values must never be ellipsised.",
	},
	"visual.clipped-text|SEVERITY_WARNING": {
		"Text is cut off inside its widget.",
		"Widen or heighten the widget, shorten the text, or let it wrap.",
	},
	"visual.internal-scroll|SEVERITY_WARNING": {
		"Widget body scrolls vertically inside its tile.",
		"Increase layout.h, or remove extra description, stat bar or sparkline text so the widget fits without a scrollbar.",
	},
	"visual.empty-plot|SEVERITY_WARNING": {
		"Chart area has data but nothing is drawn.",
		"Check the line width, display mode and series options so the series is drawn.",
	},
}

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
	ChecksOnly  bool   `json:"checks_only,omitempty"`  //nolint:tagliatelle // MCP uses snake_case.
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
	if args.ChecksOnly && args.FocusWidget != "" {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("checks_only does not capture an image, so it cannot focus a widget"))
	}
	return args, nil
}

func insightsRenderDashboardTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{Name: "render_dashboard", Title: "Render Insights dashboard in browser",
		Description: "Read-only browser screenshot of an authorized saved dashboard, with the source ETag and viewport. The result starts with a verdict line and a structured visualStatus: failed, passed or not_run. ANY SEVERITY_ERROR finding means visualStatus is failed, and the dashboard does not pass visual QA. A passed status with warnings still needs a look at each one. Findings have source SOURCE_VISUAL and rule ids visual.widget-error, visual.clipped-text, visual.internal-scroll, visual.empty-plot and visual.page-overflow, with the widget pointer where one applies. checks_only returns the findings and timings without an image. The checks are DOM heuristics, so a passed status does not prove the design is good. Requires the operator's isolated screenshot worker; no arbitrary URLs and no saved-document mutations.",
		Scope:       mcp.ScopeObserve, InputSchema: json.RawMessage(dashboardRenderSchema),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			if err := requireDashboardQueryAdmission(ctx); err != nil {
				return nil, err
			}
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
	// The worker answers JSON, which carries the visual checks with the image.
	req.Header.Set("Accept", "application/json")
	response, err := c.renderer.client.Do(req) // #nosec G704 -- Operator-configured, fixed loopback-only URL.
	if err != nil {
		return dashboardRenderFailureResult("renderer_transport", 0, 0, nil), nil
	}
	outcome, err := readDashboardRenderResponse(response, args.ChecksOnly)
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
	if args.ChecksOnly {
		return dashboardRenderResult(args, doc.ETag, details.Title, nil, outcome, widgetIDs(details.Widgets), nil), nil
	}
	config, err := png.DecodeConfig(bytes.NewReader(outcome.png))
	if err != nil {
		return dashboardRenderFailureResult("png_decode_failed", response.StatusCode, 0, nil), nil
	}
	if config.Width != args.Width || config.Height < 1 || config.Height > 12000 {
		return dashboardRenderFailureResult("png_dimensions_mismatch", response.StatusCode, 0, map[string]int{
			"expectedWidth": args.Width, "actualWidth": config.Width, "actualHeight": config.Height,
		}), nil
	}
	return dashboardRenderResult(args, doc.ETag, details.Title, &config, outcome, widgetIDs(details.Widgets), outcome.png), nil
}

// dashboardRenderResult is the successful tool result. It always starts with the
// verdict, so a client that reads only the first line still sees pass or fail. A
// capture that ran its checks is a success with a verdict, not a tool error.
func dashboardRenderResult(args dashboardRenderArgs, etag, title string, config *image.Config, outcome dashboardRenderOutcome, widgets []string, pngData []byte) *sdkmcp.CallToolResult {
	structured := map[string]any{"id": args.ID, "etag": etag, "width": args.Width, "theme": args.Theme, "source": "browser"}
	var report *insightsv1.CheckReport
	if outcome.checks != nil {
		report = visualCheckReport(outcome.checks, widgets)
		checkJSON, err := checkwire.Marshal(report)
		if err != nil {
			checkJSON = []byte(`{"issues":[],"total":0,"truncated":false}`)
		}
		structured["checks"] = json.RawMessage(checkJSON)
		structured["timings"] = outcome.timings
	}
	status := visualStatusOf(report)
	structured["visualStatus"] = status
	lines := []string{visualVerdict(status, report)}
	if config == nil {
		structured["checksOnly"] = true
		lines = append(lines, fmt.Sprintf("Visual checks of %q without an image.", title))
	} else {
		structured["height"] = config.Height
		structured["mimeType"] = "image/png"
		caption := fmt.Sprintf("Browser screenshot of %q at %dpx, %s theme.", title, args.Width, args.Theme)
		if report != nil {
			caption += " Visual checks are DOM heuristics: a passed status does not prove the design is good."
		}
		lines = append(lines, caption)
	}
	lines = append(lines, visualFindingLines(report)...)
	lines = append(lines, "Use query_dashboard separately to verify current data and errors.")
	result := &sdkmcp.CallToolResult{StructuredContent: structured, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: strings.Join(lines, "\n")}}}
	if config != nil {
		result.Content = append(result.Content, &sdkmcp.ImageContent{Data: pngData, MIMEType: "image/png"})
	}
	return result
}

// visualStatusOf is the structured verdict. A renderer that ran no checks is not_run.
func visualStatusOf(report *insightsv1.CheckReport) string {
	switch {
	case report == nil:
		return visualStatusNotRun
	case report.GetErrorCount() > 0:
		return visualStatusFailed
	default:
		return visualStatusPassed
	}
}

// visualVerdict is the first line of the text result. Counts come from the whole
// check run, so a truncated list never changes the verdict.
func visualVerdict(status string, report *insightsv1.CheckReport) string {
	switch status {
	case visualStatusFailed:
		return "Visual checks FAILED: " + visualCountPhrase(report, true) + "."
	case visualStatusPassed:
		if report.GetWarningCount() == 0 && report.GetInfoCount() == 0 {
			return "Visual checks passed with no findings."
		}
		return "Visual checks passed with " + visualCountPhrase(report, false) + "."
	default:
		return "Visual checks NOT RUN: this renderer version does not report them."
	}
}

// visualCountPhrase names the non-zero counts, for example "1 error, 2 warnings".
func visualCountPhrase(report *insightsv1.CheckReport, withErrors bool) string {
	var parts []string
	plural := func(n uint32, singular, many string) string {
		if n == 1 {
			return "1 " + singular
		}
		return fmt.Sprintf("%d %s", n, many)
	}
	if withErrors && report.GetErrorCount() > 0 {
		parts = append(parts, plural(report.GetErrorCount(), "error", "errors"))
	}
	if report.GetWarningCount() > 0 {
		parts = append(parts, plural(report.GetWarningCount(), "warning", "warnings"))
	}
	if report.GetInfoCount() > 0 {
		parts = append(parts, fmt.Sprintf("%d info", report.GetInfoCount()))
	}
	return strings.Join(parts, ", ")
}

// visualFindingLines lists the first findings, one per line, with the fix. Anything
// beyond the list is counted, and the counts above it are complete.
func visualFindingLines(report *insightsv1.CheckReport) []string {
	if report == nil {
		return nil
	}
	var lines []string
	issues := report.GetIssues()
	for i, issue := range issues {
		if i == maxVisualTextLines {
			break
		}
		location := "dashboard"
		if issue.GetWidgetId() != "" {
			location = "widget " + checkwire.Printable(issue.GetWidgetId())
		}
		lines = append(lines, fmt.Sprintf("- %s %s on %s: %s Fix: %s",
			strings.TrimPrefix(issue.GetSeverity().String(), "SEVERITY_"), issue.GetRuleId(), location,
			checkwire.Printable(issue.GetMessage()), checkwire.Printable(issue.GetFix())))
	}
	if remaining := int(report.GetTotal()) - min(len(issues), maxVisualTextLines); remaining > 0 {
		lines = append(lines, fmt.Sprintf("… %d more finding(s) in checks; the counts above include them.", remaining))
	}
	return lines
}

// dashboardRenderTimings are the worker's measurements in milliseconds.
type dashboardRenderTimings struct {
	ReadyMs  int `json:"readyMs"`
	ProbeMs  int `json:"probeMs"`
	RenderMs int `json:"renderMs"`
}

// visualCheckReport turns the worker's findings into the CheckReport the gateway
// returns. Only visual findings with a known rule and severity survive, and the
// gateway writes their text. Widget findings point at their document widget, and
// an unknown widget is dropped rather than named. Errors come first, then page-level
// findings, and the counts come from the whole run, never from the cut list.
func visualCheckReport(raw *dashboardRenderChecks, widgets []string) *insightsv1.CheckReport {
	report := &insightsv1.CheckReport{}
	if raw == nil {
		return report
	}
	index := make(map[string]int, len(widgets))
	for i, id := range widgets {
		index[id] = i
	}
	kept := make([]*insightsv1.CheckFinding, 0, len(raw.Issues))
	for _, issue := range raw.Issues {
		if finding, ok := decodeVisualFinding(issue); ok {
			kept = append(kept, finding)
		}
	}
	// Order by what the probe reported, then resolve each widget against the document.
	slices.SortStableFunc(kept, compareVisualFindings)
	for _, finding := range kept {
		resolveVisualWidget(finding, index)
	}
	errors, warnings, infos := severityCounts(kept)
	report.ErrorCount = workerCount(raw.ErrorCount, errors)
	report.WarningCount = workerCount(raw.WarningCount, warnings)
	report.InfoCount = workerCount(raw.InfoCount, infos)
	for _, finding := range kept {
		if len(report.GetIssues()) == maxVisualFindings {
			break
		}
		report.Issues = append(report.Issues, finding)
	}
	report.Total = max(raw.Total, report.GetErrorCount()+report.GetWarningCount()+report.GetInfoCount())
	report.Truncated = raw.Truncated || report.GetTotal() > checkwire.Count(len(report.GetIssues()))
	return report
}

// workerCount keeps the worker's count when it is present, and never below the
// findings the gateway itself kept.
func workerCount(reported *uint32, kept uint32) uint32 {
	if reported == nil {
		return kept
	}
	return max(*reported, kept)
}

// decodeVisualFinding accepts one worker finding only when it is a visual finding with a
// known rule and severity. It replaces the message and fix with the gateway's text.
func decodeVisualFinding(issue json.RawMessage) (*insightsv1.CheckFinding, bool) {
	var finding insightsv1.CheckFinding
	if checkwire.Unmarshal(issue, &finding) != nil || finding.GetSource() != insightsv1.Source_SOURCE_VISUAL {
		return nil, false
	}
	text, known := dashboardVisualText[finding.GetRuleId()+"|"+finding.GetSeverity().String()]
	if !known {
		return nil, false
	}
	finding.Message = text.message
	finding.Fix = text.fix
	finding.Pointer = ""
	return checkwire.Bound(&finding), true
}

// resolveVisualWidget points a widget finding at its document widget. A widget the
// document does not contain is unnamed, and page-level findings never carry a pointer.
func resolveVisualWidget(finding *insightsv1.CheckFinding, index map[string]int) {
	finding.Pointer = ""
	if position, ok := index[finding.GetWidgetId()]; ok && finding.GetWidgetId() != "" {
		finding.Pointer = "/widgets/" + strconv.Itoa(position)
		return
	}
	finding.WidgetId = ""
}

// compareVisualFindings orders errors first, then warnings, then info. Within a severity,
// page-level findings come before widget findings, and probe order is kept otherwise.
func compareVisualFindings(a, b *insightsv1.CheckFinding) int {
	return cmp.Or(
		cmp.Compare(visualSeverityRank(a.GetSeverity()), visualSeverityRank(b.GetSeverity())),
		cmp.Compare(boolRank(a.GetWidgetId() != ""), boolRank(b.GetWidgetId() != "")),
	)
}

func visualSeverityRank(severity insightsv1.Severity) int {
	switch severity {
	case insightsv1.Severity_SEVERITY_ERROR:
		return 0
	case insightsv1.Severity_SEVERITY_WARNING:
		return 1
	case insightsv1.Severity_SEVERITY_INFO, insightsv1.Severity_SEVERITY_UNSPECIFIED:
	}
	return 2
}

func boolRank(value bool) int {
	if value {
		return 1
	}
	return 0
}

func severityCounts(findings []*insightsv1.CheckFinding) (errors, warnings, infos uint32) {
	for _, finding := range findings {
		switch finding.GetSeverity() {
		case insightsv1.Severity_SEVERITY_ERROR:
			errors++
		case insightsv1.Severity_SEVERITY_WARNING:
			warnings++
		case insightsv1.Severity_SEVERITY_INFO:
			infos++
		case insightsv1.Severity_SEVERITY_UNSPECIFIED:
		}
	}
	return errors, warnings, infos
}

func widgetIDs(widgets []struct {
	ID string `json:"id"`
}) []string {
	ids := make([]string, 0, len(widgets))
	for _, widget := range widgets {
		ids = append(ids, widget.ID)
	}
	return ids
}

// dashboardRenderChecks is the worker's CheckReport list shape. Issues stay raw
// until each one has been decoded and validated. Counts are pointers, so a
// worker that omits them is distinguished from one that reports zero.
type dashboardRenderChecks struct {
	Issues       []json.RawMessage `json:"issues"`
	Total        uint32            `json:"total"`
	ErrorCount   *uint32           `json:"errorCount"`
	WarningCount *uint32           `json:"warningCount"`
	InfoCount    *uint32           `json:"infoCount"`
	Truncated    bool              `json:"truncated"`
}

// boundedTimings clamps worker measurements to a plausible range, so a
// misbehaving renderer cannot put arbitrary numbers in the tool result.
func boundedTimings(timings dashboardRenderTimings) dashboardRenderTimings {
	clamp := func(value int) int { return min(max(value, 0), 600000) }
	return dashboardRenderTimings{ReadyMs: clamp(timings.ReadyMs), ProbeMs: clamp(timings.ProbeMs), RenderMs: clamp(timings.RenderMs)}
}

// dashboardRenderOutcome is one successful worker response.
type dashboardRenderOutcome struct {
	png     []byte
	checks  *dashboardRenderChecks
	timings dashboardRenderTimings
}

// readDashboardRenderResponse validates one worker response. The worker's JSON
// envelope carries the base64 PNG, the visual checks and timings. A PNG-only
// response is still accepted from a worker that predates the envelope; it has
// no checks, so it cannot answer checks_only.
func readDashboardRenderResponse(response *http.Response, checksOnly bool) (dashboardRenderOutcome, error) {
	data, readErr := io.ReadAll(io.LimitReader(response.Body, dashboardRenderMaxResponse+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		return dashboardRenderOutcome{}, &dashboardRenderFailure{category: "renderer_response_read", status: response.StatusCode}
	}
	if response.StatusCode == http.StatusConflict {
		return dashboardRenderOutcome{}, connect.NewError(connect.CodeAborted, errors.New("dashboard changed during browser capture; render again"))
	}
	if response.StatusCode != http.StatusOK {
		return dashboardRenderOutcome{}, &dashboardRenderFailure{
			category: dashboardRenderFailureCategory(response.Header), status: response.StatusCode,
			upstreamStatus: dashboardRenderUpstreamStatus(response.Header),
		}
	}
	mediaType := response.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(mediaType, "application/json"):
		return readDashboardRenderEnvelope(data, response.StatusCode, checksOnly)
	case strings.HasPrefix(mediaType, "image/png") && !checksOnly:
		if len(data) > dashboardRenderMaxPNG {
			return dashboardRenderOutcome{}, connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard screenshot exceeds 4 MiB"))
		}
		return dashboardRenderOutcome{png: data}, nil
	default:
		return dashboardRenderOutcome{}, &dashboardRenderFailure{category: "renderer_content_type", status: response.StatusCode}
	}
}

// readDashboardRenderEnvelope decodes the JSON envelope. Without checks_only it
// must also carry a PNG within the image bound.
func readDashboardRenderEnvelope(data []byte, status int, checksOnly bool) (dashboardRenderOutcome, error) {
	if len(data) > dashboardRenderMaxResponse {
		return dashboardRenderOutcome{}, connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard screenshot exceeds 4 MiB"))
	}
	var envelope struct {
		PNG     string                 `json:"png"`
		Checks  *dashboardRenderChecks `json:"checks"`
		Timings dashboardRenderTimings `json:"timings"`
	}
	malformed := &dashboardRenderFailure{category: "renderer_response_read", status: status}
	if json.Unmarshal(data, &envelope) != nil || envelope.Checks == nil {
		return dashboardRenderOutcome{}, malformed
	}
	outcome := dashboardRenderOutcome{checks: envelope.Checks, timings: boundedTimings(envelope.Timings)}
	if checksOnly {
		return outcome, nil
	}
	if envelope.PNG == "" {
		return dashboardRenderOutcome{}, malformed
	}
	decoded, err := base64.StdEncoding.DecodeString(envelope.PNG)
	if err != nil {
		return dashboardRenderOutcome{}, &dashboardRenderFailure{category: "png_decode_failed", status: status}
	}
	if len(decoded) > dashboardRenderMaxPNG {
		return dashboardRenderOutcome{}, connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard screenshot exceeds 4 MiB"))
	}
	outcome.png = decoded
	return outcome, nil
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
	"widget_readiness": {}, "widget_error": {}, "focus_unavailable": {}, "visual_check_failed": {},
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
