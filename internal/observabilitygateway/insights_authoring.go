package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

var insightsDocumentID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`)
var insightsDocumentETag = regexp.MustCompile(`^"[a-f0-9]{64}"$`)

// InsightsAuthoringClient uses the same authenticated HTTP proxy as the UI.
// It never talks to the storage service with an unguarded service credential.
// Every call retains the human identity, exact groups, and Insights RBAC checks.
type InsightsAuthoringClient struct {
	client    *http.Client
	secret    []byte
	publicURL string
	auditor   audit.Auditor
	renderer  *dashboardPreviewRenderer
}

func NewInsightsAuthoringClient(handler http.Handler, secret []byte, publicURL string, auditor audit.Auditor) (*InsightsAuthoringClient, error) {
	if handler == nil || len(secret) == 0 {
		return nil, errors.New("insights authoring requires an authenticated proxy and signing secret")
	}
	u, err := url.Parse(publicURL)
	if err != nil || strings.Contains(publicURL, "#") || !validInsightsPublicURL(u) {
		return nil, errors.New("insights authoring requires an HTTP(S) public origin")
	}
	if auditor == nil {
		auditor = audit.NoopAuditor{}
	}
	return &InsightsAuthoringClient{client: &http.Client{Transport: mcp.NewInProcessTransport(handler), Timeout: 28 * time.Second}, secret: append([]byte{}, secret...), publicURL: strings.TrimSuffix(publicURL, "/"), auditor: auditor}, nil
}

func validInsightsPublicURL(u *url.URL) bool {
	return u.Hostname() != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && !u.ForceQuery && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}

type insightsDocumentResult struct {
	Document json.RawMessage `json:"document"`
	ETag     string          `json:"etag"`
	UIURL    string          `json:"uiUrl"`
	// Checks is the warnings report of a successful save. It is returned beside
	// the document, never inside it, so an agent cannot re-PUT it.
	Checks *insightsv1.CheckReport `json:"-"`
	// Placements reports where each widget_edits add landed on the saved grid. Only a patch sets it.
	Placements []insightsPlacement `json:"placements,omitempty"`
}

type insightsAuthoringArgs struct {
	ID         string          `json:"id,omitempty"`
	ProviderID string          `json:"provider_id,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
	Document   json.RawMessage `json:"document,omitempty"`
	ETag       string          `json:"etag,omitempty"`
}

func decodeInsightsAuthoringArgs(raw json.RawMessage) (insightsAuthoringArgs, error) {
	var args insightsAuthoringArgs
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Insights tool arguments"))
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("expected one argument object"))
	}
	return args, nil
}

func (c *InsightsAuthoringClient) credential(ctx context.Context, write bool) (string, error) {
	p := auth.PrincipalFromContext(ctx)
	if p == nil || p.Subject == "" {
		return "", connect.NewError(connect.CodeUnauthenticated, errors.New("authenticated authoring principal required"))
	}
	if !principalObserves(p) {
		return "", connect.NewError(connect.CodePermissionDenied, errors.New("paprika:observe is required for Insights authoring"))
	}
	if write && !hasInsightsWriteScope(p) {
		return "", connect.NewError(connect.CodePermissionDenied, errors.New("paprika:insights:write is required"))
	}
	credential, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: p.Subject, Email: p.Email, Name: p.Name, Groups: append([]string{}, p.Groups...), Audience: auth.ConsoleAPIAudience, Issuer: c.publicURL, TTL: 30 * time.Second, Secret: c.secret})
	if err != nil {
		return "", connect.NewError(connect.CodeInternal, errors.New("could not authorize Insights request"))
	}
	return credential, nil
}

func hasInsightsWriteScope(p *auth.Principal) bool {
	for _, scope := range p.Scopes {
		if scope == string(mcp.ScopeInsightsWrite) {
			return true
		}
	}
	return false
}

func (c *InsightsAuthoringClient) request(ctx context.Context, method, path string, document json.RawMessage, headers http.Header) (body json.RawMessage, tag string, err error) {
	return c.requestAuthorized(ctx, method, path, document, headers, method != http.MethodGet, 2<<20)
}

// requestAuthorized keeps the action explicit for read-only POST operations.
// Its callers use fixed routes; arbitrary authoring routes cannot opt into read access.
func (c *InsightsAuthoringClient) requestAuthorized(ctx context.Context, method, path string, document json.RawMessage, headers http.Header, write bool, limit int64) (body json.RawMessage, tag string, err error) {
	credential, err := c.credential(ctx, write)
	if err != nil {
		return nil, "", err
	}
	// The origin is deliberately synthetic: this transport calls only the injected proxy.
	req, err := http.NewRequestWithContext(ctx, method, "http://insights.in-process/api/insights/"+path, bytes.NewReader(document))
	if err != nil {
		return nil, "", connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Insights request"))
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req) // #nosec G704 -- Fixed in-process origin and injected transport; no caller-selected network destination.
	if err != nil {
		return nil, "", insightsTransportError(ctx)
	}
	return readInsightsResponseLimit(resp, limit)
}

func readInsightsResponseLimit(resp *http.Response, limit int64) (payload json.RawMessage, tag string, err error) {
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	closeErr := resp.Body.Close()
	if readErr != nil || closeErr != nil {
		return nil, "", connect.NewError(connect.CodeUnavailable, errors.New("insights response could not be read"))
	}
	if int64(len(body)) > limit {
		return nil, "", connect.NewError(connect.CodeResourceExhausted, errors.New("insights response exceeds its size limit"))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", insightsStatusError(resp.StatusCode, body, resp.Header)
	}
	if !json.Valid(body) {
		return nil, "", connect.NewError(connect.CodeInternal, errors.New("insights returned invalid JSON"))
	}
	return body, resp.Header.Get("ETag"), nil
}

func insightsTransportError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return connect.NewError(connect.CodeCanceled, errors.New("insights request canceled"))
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, errors.New("insights request timed out"))
	}
	return connect.NewError(connect.CodeUnavailable, errors.New("insights service is unavailable"))
}

type insightsHTTPFailure struct {
	code    connect.Code
	message string
}

var insightsHTTPFailures = map[int]insightsHTTPFailure{
	http.StatusBadRequest:            {connect.CodeInvalidArgument, "invalid Insights document"},
	http.StatusUnauthorized:          {connect.CodeUnauthenticated, "insights authentication required"},
	http.StatusForbidden:             {connect.CodePermissionDenied, "insights permission denied"},
	http.StatusNotFound:              {connect.CodeNotFound, "insights document not found"},
	http.StatusConflict:              {connect.CodeFailedPrecondition, "saved query identity or parameter changes conflict with existing dashboard references"},
	http.StatusPreconditionFailed:    {connect.CodeAborted, "document already exists or has changed; get the latest document and ETag before retrying"},
	http.StatusPreconditionRequired:  {connect.CodeFailedPrecondition, "a current document ETag is required"},
	http.StatusRequestEntityTooLarge: {connect.CodeResourceExhausted, "insights request capacity exceeded"},
	http.StatusTooManyRequests:       {connect.CodeResourceExhausted, "insights request capacity exceeded"},
	http.StatusInsufficientStorage:   {connect.CodeResourceExhausted, "insights storage capacity exceeded"},
	http.StatusBadGateway:            {connect.CodeUnavailable, "insights service is unavailable"},
	http.StatusServiceUnavailable:    {connect.CodeUnavailable, "insights service is unavailable"},
	http.StatusGatewayTimeout:        {connect.CodeUnavailable, "insights service is unavailable"},
}

// insightsStatusError maps a failed Insights response to a Connect error. The
// message is fixed text, or the service's own short validation message. A 400
// also carries the bounded finding list as a CheckReport detail, and a capacity
// response that names a Retry-After carries a RetryInfo detail. Upstream bodies
// are never copied beyond those two fields.
func insightsStatusError(status int, body []byte, header http.Header) *connect.Error {
	failure, ok := insightsHTTPFailures[status]
	if !ok {
		failure = insightsHTTPFailure{connect.CodeInternal, "insights request failed"}
	}
	var report *insightsv1.CheckReport
	if status == http.StatusBadRequest {
		var response struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &response) == nil && len(response.Error) <= 512 && response.Error != "" {
			failure.message = response.Error
		}
		report = insightsCheckReport(body)
	}
	err := connect.NewError(failure.code, errors.New(failure.message))
	if report != nil {
		if detail, detailErr := connect.NewErrorDetail(report); detailErr == nil {
			err.AddDetail(detail)
		}
	}
	if delay, ok := insightsRetryDelay(status, header); ok {
		if detail, detailErr := connect.NewErrorDetail(&errdetails.RetryInfo{RetryDelay: durationpb.New(delay)}); detailErr == nil {
			err.AddDetail(detail)
		}
	}
	return err
}

// insightsValidationBody is the 400 body of a rejected save: Error keeps the
// single historical message, and the rest is the CheckReport list shape.
type insightsValidationBody struct {
	Error     string            `json:"error"`
	Issues    []json.RawMessage `json:"issues"`
	Total     uint32            `json:"total"`
	Truncated bool              `json:"truncated"`
	// Severity counts cover every finding the service found, not only the
	// issues it returned. Older services omit them.
	ErrorCount   *uint32 `json:"errorCount"`
	WarningCount *uint32 `json:"warningCount"`
	InfoCount    *uint32 `json:"infoCount"`
}

// insightsCheckReport decodes the issue list of a 400 and bounds every finding,
// so a changed or misbehaving service cannot widen what an agent receives.
func insightsCheckReport(body []byte) *insightsv1.CheckReport {
	var response insightsValidationBody
	if json.Unmarshal(body, &response) != nil || len(response.Issues) == 0 {
		return nil
	}
	return boundCheckReport(response)
}

// insightsChecksReport decodes a CheckReport that a successful response or the
// dry run carries. Unlike insightsCheckReport it keeps an empty report, so a
// clean document still gets its "Checks passed" verdict.
func insightsChecksReport(raw []byte) (*insightsv1.CheckReport, error) {
	var response insightsValidationBody
	if json.Unmarshal(raw, &response) != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid check report"))
	}
	return boundCheckReport(response), nil
}

func boundCheckReport(response insightsValidationBody) *insightsv1.CheckReport {
	report := &insightsv1.CheckReport{}
	for _, raw := range response.Issues {
		if len(report.GetIssues()) == checkwire.MaxIssues {
			break
		}
		var finding insightsv1.CheckFinding
		if checkwire.Unmarshal(raw, &finding) != nil {
			continue
		}
		report.Issues = append(report.Issues, checkwire.Bound(&finding))
	}
	decoded := checkwire.CountSeverities(report.GetIssues())
	report.ErrorCount = serviceCount(response.ErrorCount, decoded.Errors)
	report.WarningCount = serviceCount(response.WarningCount, decoded.Warnings)
	report.InfoCount = serviceCount(response.InfoCount, decoded.Infos)
	report.Total = max(response.Total, checkwire.Count(len(response.Issues)), report.GetErrorCount()+report.GetWarningCount()+report.GetInfoCount())
	report.Truncated = response.Truncated || report.GetTotal() > checkwire.Count(len(report.GetIssues()))
	return report
}

// serviceCount prefers the service's own severity count, which covers findings
// past the issue cap, and never reports fewer than the issues decoded here.
func serviceCount(reported *uint32, decoded uint32) uint32 {
	if reported == nil {
		return decoded
	}
	return max(min(*reported, 1<<16), decoded)
}

// maxInsightsRetryAfterSecs bounds the delay a Retry-After may ask an agent to wait.
const maxInsightsRetryAfterSecs = 300

// insightsRetryDelay reads a Retry-After in seconds from a throttling response.
// Only 429 carries it: it maps to ResourceExhausted, the code agents receive
// with their retry delay. Unavailable is reported without one, as every other
// unavailable upstream is. A date-form or out-of-range value is ignored.
func insightsRetryDelay(status int, header http.Header) (time.Duration, bool) {
	if status != http.StatusTooManyRequests {
		return 0, false
	}
	seconds, err := strconv.Atoi(strings.TrimSpace(header.Get("Retry-After")))
	if err != nil || seconds < 1 || seconds > maxInsightsRetryAfterSecs {
		return 0, false
	}
	return time.Duration(seconds) * time.Second, true
}

func (c *InsightsAuthoringClient) get(ctx context.Context, collection, id string) (*insightsDocumentResult, error) {
	if !insightsDocumentID.MatchString(id) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid document ID"))
	}
	body, etag, err := c.request(ctx, http.MethodGet, collection+"/"+id, nil, nil)
	if err != nil {
		return nil, err
	}
	return c.documentResult(collection, id, body, etag)
}

// checksMemberPrefix introduces the checks member that a checks=true dashboard
// save appends. The service writes that member last, compact, after the saved
// document. A quote inside a JSON string is always escaped, so the last
// occurrence of this prefix is the service's own member.
var checksMemberPrefix = []byte(`,"checks":`)

// splitInsightsChecks removes the checks member a checks=true save appends and
// decodes it. Only the trailing member is cut: the document bytes keep their
// saved order and spelling. A body without the member (an older service) is
// returned unchanged.
func splitInsightsChecks(body json.RawMessage) (json.RawMessage, *insightsv1.CheckReport, error) {
	trimmed := bytes.TrimRight(body, " \t\r\n")
	at := bytes.LastIndex(trimmed, checksMemberPrefix)
	if at < 0 {
		return body, nil, nil
	}
	// The member is "<report>}" where the final brace closes the document.
	members := trimmed[at+len(checksMemberPrefix):]
	if len(members) == 0 || members[len(members)-1] != '}' {
		return nil, nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid document"))
	}
	report, err := insightsChecksReport(members[:len(members)-1])
	if err != nil {
		return nil, nil, err
	}
	document := make([]byte, 0, at+1)
	document = append(document, trimmed[:at]...)
	document = append(document, '}')
	if !json.Valid(document) {
		return nil, nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid document"))
	}
	return document, report, nil
}

func (c *InsightsAuthoringClient) put(ctx context.Context, collection string, args insightsAuthoringArgs, create bool) (result *insightsDocumentResult, err error) {
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args.Document, &identity) != nil || !insightsDocumentID.MatchString(identity.ID) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document must contain a valid id"))
	}
	defer func() { c.auditMutation(ctx, collection, identity.ID, create, err) }()
	headers := make(http.Header)
	if create {
		headers.Set("If-None-Match", "*")
	} else {
		if !insightsDocumentETag.MatchString(args.ETag) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("update requires the exact ETag returned by get; wildcard and weak ETags are not allowed"))
		}
		headers.Set("If-Match", args.ETag)
	}
	// Dashboard saves ask for their warnings beside the saved document. The
	// document itself is returned without them. Saved queries have no checks.
	path := collection + "/" + identity.ID
	if collection == "dashboards" {
		path += "?checks=true"
	}
	body, etag, err := c.request(ctx, http.MethodPut, path, args.Document, headers)
	if err != nil {
		return nil, err
	}
	var report *insightsv1.CheckReport
	if collection == "dashboards" {
		if body, report, err = splitInsightsChecks(body); err != nil {
			return nil, err
		}
	}
	result, err = c.documentResult(collection, identity.ID, body, etag)
	if err != nil {
		return nil, err
	}
	result.Checks = report
	return result, nil
}

func (c *InsightsAuthoringClient) documentResult(collection, id string, body json.RawMessage, etag string) (*insightsDocumentResult, error) {
	if !insightsDocumentETag.MatchString(etag) {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights did not return a valid document ETag"))
	}
	target := c.publicURL + "/dashboard/insights/"
	if collection == "dashboards" {
		target += "?dashboard=" + url.QueryEscape(id)
	}
	return &insightsDocumentResult{Document: body, ETag: etag, UIURL: target}, nil
}

func (c *InsightsAuthoringClient) auditMutation(ctx context.Context, collection, id string, create bool, err error) {
	p := auth.PrincipalFromContext(ctx)
	subject := ""
	if p != nil {
		subject = p.Subject
	}
	action := "update"
	if create {
		action = "create"
	}
	outcome := ""
	if err != nil {
		outcome = connect.CodeOf(err).String()
	}
	c.auditor.Record(ctx, audit.Event{Principal: subject, Action: action, Resource: collection, Name: id, Success: err == nil, Error: outcome, Extra: map[string]string{"surface": "observe_mcp"}})
}

func (c *InsightsAuthoringClient) list(ctx context.Context, collection, providerID string) (json.RawMessage, error) {
	path := collection
	if collection != "providers" {
		path += "?summary=true"
	}
	if providerID != "" {
		if collection != "saved-queries" || !insightsDocumentID.MatchString(providerID) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid provider ID"))
		}
		path += "&providerId=" + url.QueryEscape(providerID)
	}
	body, _, err := c.request(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("list Insights documents: %w", err)
	}
	return body, nil
}

// sharedCatalogListing is the part of an Insights providers listing that
// reports a degraded shared catalog. Insights answers 200 for that case so the
// UI keeps its local tiles; an agent needs the failure as a tool error, or as a
// note beside the providers it can still use.
type sharedCatalogListing struct {
	Providers     []json.RawMessage `json:"providers"`
	SharedCatalog *struct {
		Status     string `json:"status"`
		RetryAfter int    `json:"retryAfter"`
	} `json:"sharedCatalog"`
}

// listProviders serves list_insights_providers. A healthy listing passes
// through unchanged. A degraded shared catalog with no providers at all becomes
// the error the gateway returned before the catalog was reported in the body,
// so an agent never reads an empty list as "no data sources". With providers
// alongside it, the listing succeeds and a one-line note names the degradation.
// The listing takes no provider filter, so a provider ID is rejected the way
// the other list calls reject a malformed one.
func (c *InsightsAuthoringClient) listProviders(ctx context.Context, providerID string) (any, error) {
	if providerID != "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid provider ID"))
	}
	body, err := c.list(ctx, "providers", "")
	if err != nil {
		return nil, err
	}
	var listing sharedCatalogListing
	if json.Unmarshal(body, &listing) != nil || listing.SharedCatalog == nil {
		return body, nil
	}
	status := listing.SharedCatalog.Status
	retry := retryAfterSeconds(listing.SharedCatalog.RetryAfter)
	if len(listing.Providers) > 0 {
		return &sdkmcp.CallToolResult{
			StructuredContent: body,
			Content: []sdkmcp.Content{
				&sdkmcp.TextContent{Text: string(body)},
				&sdkmcp.TextContent{Text: sharedCatalogNote(status, retry)},
			},
		}, nil
	}
	switch status {
	case "busy":
		err := connect.NewError(connect.CodeResourceExhausted, errors.New("observability provider catalog is busy"))
		if detail, detailErr := connect.NewErrorDetail(&errdetails.RetryInfo{RetryDelay: durationpb.New(time.Duration(retry) * time.Second)}); detailErr == nil {
			err.AddDetail(detail)
		}
		return nil, err
	case "forbidden":
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("shared observability provider access denied"))
	default:
		return unavailableProvidersResult(), nil
	}
}

// unavailableProvidersResult is the tool error for an unavailable or failed
// shared catalog. It is an MCP tool error rather than a protocol error, so the
// agent receives the text and the client can pass it to the model.
func unavailableProvidersResult() *sdkmcp.CallToolResult {
	return &sdkmcp.CallToolResult{
		IsError:           true,
		StructuredContent: map[string]any{"error": map[string]any{"code": connect.CodeUnavailable.String()}},
		Content:           []sdkmcp.Content{&sdkmcp.TextContent{Text: "The shared observability provider catalog is unavailable; retry later."}},
	}
}

// retryAfterSeconds keeps a catalog's retry delay in the range an agent is told
// to wait: at least one second, and at most the gateway's own 60 second bound.
func retryAfterSeconds(seconds int) int {
	return min(max(seconds, 1), 60)
}

func sharedCatalogNote(status string, retryAfter int) string {
	switch status {
	case "busy":
		return fmt.Sprintf("Note: the shared observability catalog is busy, so shared providers are missing from this list. Retry after %d seconds.", retryAfterSeconds(retryAfter))
	case "forbidden":
		return "Note: shared observability providers are not available to this caller, so they are missing from this list."
	default:
		return "Note: the shared observability catalog is unavailable, so shared providers are missing from this list."
	}
}
