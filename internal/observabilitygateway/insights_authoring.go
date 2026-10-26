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
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/audit"
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

func (c *InsightsAuthoringClient) request(ctx context.Context, method, path string, document json.RawMessage, headers http.Header) (json.RawMessage, string, error) {
	return c.requestAuthorized(ctx, method, path, document, headers, method != http.MethodGet, 2<<20)
}

// requestAuthorized keeps the action explicit for read-only POST operations.
// Its callers use fixed routes; arbitrary authoring routes cannot opt into read access.
func (c *InsightsAuthoringClient) requestAuthorized(ctx context.Context, method, path string, document json.RawMessage, headers http.Header, write bool, limit int64) (json.RawMessage, string, error) {
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

func readInsightsResponseLimit(resp *http.Response, limit int64) (json.RawMessage, string, error) {
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	closeErr := resp.Body.Close()
	if readErr != nil || closeErr != nil {
		return nil, "", connect.NewError(connect.CodeUnavailable, errors.New("insights response could not be read"))
	}
	if int64(len(body)) > limit {
		return nil, "", connect.NewError(connect.CodeResourceExhausted, errors.New("insights response exceeds its size limit"))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", insightsStatusError(resp.StatusCode, body)
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

func insightsStatusError(status int, body []byte) error {
	failure, ok := insightsHTTPFailures[status]
	if !ok {
		failure = insightsHTTPFailure{connect.CodeInternal, "insights request failed"}
	}
	if status == http.StatusBadRequest {
		var response struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &response) == nil && len(response.Error) <= 512 && response.Error != "" {
			failure.message = response.Error
		}
	}
	return connect.NewError(failure.code, errors.New(failure.message))
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
	body, etag, err := c.request(ctx, http.MethodPut, collection+"/"+identity.ID, args.Document, headers)
	if err != nil {
		return nil, err
	}
	return c.documentResult(collection, identity.ID, body, etag)
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
