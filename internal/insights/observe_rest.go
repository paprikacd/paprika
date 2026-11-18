package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptrace"
)

// The Observe data path is the gateway's dashboard REST routes, called with the
// caller's delegated bearer. They serve the same payloads as the MCP data tools
// (the same provider state, data and error codes), in one request per call.
// MCP remains only for the Data sources status (observe_mcp.go).
const (
	observeRESTProvidersPath = "/observe/api/providers"
	observeRESTQueryPath     = "/observe/api/query"
	observeRESTExplorePath   = "/observe/api/explore"
)

// observeRESTMethods is the complete allowlist of gateway paths Insights calls.
var observeRESTMethods = map[string]string{
	observeRESTProvidersPath: http.MethodGet,
	observeRESTQueryPath:     http.MethodPost,
	observeRESTExplorePath:   http.MethodPost,
}

// restDo performs one gateway REST call and returns its bounded JSON body. Only
// the three routes above are reachable. Redirects are not followed, and a
// non-2xx body is never read into an error: its status and Retry-After map to
// the fixed sanitized errors that the MCP path produces. The receipt's dispatch
// mark is set once a connection is ready and the request is about to leave.
func (g *observeGateway) restDo(ctx context.Context, token, path string, body any, limit int64, m *queryMeasurement) ([]byte, error) {
	method, ok := observeRESTMethods[path]
	if !ok || token == "" {
		return nil, errUpstream
	}
	opCtx, stop := g.operation(ctx, ctx)
	defer stop()
	if err := opCtx.Err(); err != nil {
		return nil, observeRESTError(ctx, opCtx, err)
	}
	request, err := g.newRESTRequest(opCtx, token, method, path, body)
	if err != nil {
		return nil, err
	}
	// The trace marks dispatch when a connection is ready and the request is
	// about to leave. A request that never connects (DNS, dial) is not dispatched.
	trace := &httptrace.ClientTrace{GotConn: func(httptrace.GotConnInfo) { m.dispatch() }}
	request = request.WithContext(httptrace.WithClientTrace(opCtx, trace))
	response, err := g.client.Do(request) //nolint:gosec // The base URL is operator-configured; the path is an allowlisted constant.
	if err != nil {
		return nil, observeRESTError(ctx, opCtx, err)
	}
	return readRESTResponse(ctx, opCtx, response, limit)
}

// newRESTRequest builds one allowlisted gateway request with the delegated bearer.
func (g *observeGateway) newRESTRequest(ctx context.Context, token, method, path string, body any) (*http.Request, error) {
	u := *g.baseURL
	u.Path, u.RawPath, u.RawQuery, u.Fragment = path, "", "", ""
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, errUpstream
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, u.String(), reader) //nolint:gosec // The base URL is operator-configured; the path is an allowlisted constant.
	if err != nil {
		return nil, errUpstream
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

// readRESTResponse returns a 2xx body within limit. Any other status is mapped
// without reading its body.
func readRESTResponse(ctx, opCtx context.Context, response *http.Response, limit int64) ([]byte, error) {
	defer closeReadBody(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, observeRESTStatusError(response)
	}
	if response.ContentLength > limit {
		return nil, errUpstream
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		// An expired operation can end the body read as well as the request.
		return nil, observeRESTError(ctx, opCtx, err)
	}
	if int64(len(data)) > limit {
		return nil, errUpstream
	}
	return data, nil
}

// observeCanceledError and observeNotConfiguredError are the fixed errors for a
// canceled request and a provider that is not fully configured. The MCP domain
// codes and the REST envelope both map to them.
func observeCanceledError() error {
	return &observeError{http.StatusRequestTimeout, "observability request was canceled", 0}
}

func observeNotConfiguredError() error {
	return &observeError{http.StatusServiceUnavailable, "observability provider is not fully configured", 0}
}

// observeEnvelopeMaxBytes bounds the gateway's error envelope when a 408 or 503
// must be classified. A larger or foreign body is never read further.
const observeEnvelopeMaxBytes = 4 << 10

// observeRESTStatusError maps a non-2xx gateway response. The gateway's 408 and
// 503 mean a canceled request and an unconfigured provider only inside its own
// JSON envelope (error "temporarily_unavailable"). Any other 408 or 503, such as
// one from a proxy or a draining pod in front of the gateway, is the generic
// gateway failure. Other statuses map as the MCP transport maps them.
func observeRESTStatusError(response *http.Response) error {
	status := response.StatusCode
	if status != http.StatusRequestTimeout && status != http.StatusServiceUnavailable {
		return observeHTTPErrorFor(status, response.Header.Get("Retry-After"))
	}
	if !gatewayUnavailableEnvelope(response) {
		return observeHTTPError(http.StatusBadGateway)
	}
	if status == http.StatusRequestTimeout {
		return observeCanceledError()
	}
	return observeNotConfiguredError()
}

// gatewayUnavailableEnvelope reports whether the response is the gateway's own
// temporarily_unavailable JSON envelope. It reads at most observeEnvelopeMaxBytes.
func gatewayUnavailableEnvelope(response *http.Response) bool {
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return false
	}
	if response.ContentLength > observeEnvelopeMaxBytes {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, observeEnvelopeMaxBytes+1))
	if err != nil || len(body) > observeEnvelopeMaxBytes {
		return false
	}
	var envelope struct {
		Error string `json:"error"`
	}
	return json.Unmarshal(body, &envelope) == nil && envelope.Error == "temporarily_unavailable"
}

// observeRESTQuery is the gateway's DashboardQueryRequest. Field names and
// bounds are the gateway's; only the fields Insights sets are present.
type observeRESTQuery struct {
	Provider    string  `json:"provider"`
	Signal      string  `json:"signal"`
	Query       string  `json:"query"`
	TraceID     string  `json:"traceId,omitempty"`
	Start       string  `json:"start"`
	End         string  `json:"end"`
	StepSeconds float64 `json:"stepSeconds,omitempty"`
	Limit       int     `json:"limit,omitempty"`
}

// observeRESTExplore is the gateway's DashboardExploreRequest.
type observeRESTExplore struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	Metric   string `json:"metric,omitempty"`
	Label    string `json:"label,omitempty"`
	Limit    int    `json:"limit,omitempty"`
	Start    string `json:"start"`
	End      string `json:"end"`
}

// observeRESTProvidersResponse is the gateway's DashboardProvidersResponse.
type observeRESTProvidersResponse struct {
	Providers []observeCatalogProvider `json:"providers"`
}

// listShared fetches the caller's shared catalog over REST.
func (g *observeGateway) listShared(ctx context.Context, token string) ([]Provider, error) {
	body, err := g.restDo(ctx, token, observeRESTProvidersPath, nil, 1<<20, nil)
	if err != nil {
		return nil, err
	}
	var response observeRESTProvidersResponse
	if json.Unmarshal(body, &response) != nil || response.Providers == nil {
		return nil, errUpstream
	}
	return sharedProvidersFromCatalog(response.Providers)
}

// sharedProvidersFromCatalog keeps the catalog entries Insights can query and
// gives each one its opaque, namespace-qualified identity. Any malformed or
// duplicate entry fails the whole listing, as it always has.
func sharedProvidersFromCatalog(catalog []observeCatalogProvider) ([]Provider, error) {
	result := make([]Provider, 0, len(catalog))
	seen := make(map[string]bool)
	for _, p := range catalog {
		capabilities := observeCapabilities(p.Type)
		if len(capabilities) == 0 {
			continue
		}
		if !validObserveCatalogProvider(p) || seen[p.Name] {
			return nil, errUpstream
		}
		seen[p.Name] = true
		result = append(result, Provider{ID: observeProviderID(p.Name), Name: p.Name, Type: p.Type, Capabilities: capabilities, Source: "observability", ProviderRef: p.Name, Transport: "mcp"})
	}
	return result, nil
}

// observeRESTQueryBody builds the gateway query request for one provider query.
func observeRESTQueryBody(p *observeProvider, q *Query) observeRESTQuery {
	request := observeRESTQuery{Provider: p.reference, Signal: q.Kind, Query: q.Query, Start: observeTime(q.Start), End: observeTime(q.End)}
	switch q.Kind {
	case "metrics":
		request.StepSeconds = q.Step
		request.Limit = maxSeries
	case "records":
		request.Limit = 1000
	default:
		request.Limit = maxTraces
		request.TraceID = q.TraceID
	}
	return request
}

// observeRESTError names why a REST call ended early. When the caller's own
// context ended it (the request's budget, or a cancellation), that context's
// error is returned, so the query names its budget as it did over MCP. When only
// the operation cap ended it, the gateway timeout is reported.
func observeRESTError(ctx, opCtx context.Context, err error) error {
	if cause := ctx.Err(); cause != nil {
		return fmt.Errorf("observe REST request: %w", cause)
	}
	// The caller's deadline and the operation cap can fire together. When the cap
	// does not end before the caller's deadline, the caller's budget is the cause.
	if budget, ok := ctx.Deadline(); ok && errors.Is(err, context.DeadlineExceeded) {
		if operation, ok := opCtx.Deadline(); !ok || !operation.Before(budget) {
			return fmt.Errorf("observe REST request: %w", context.DeadlineExceeded)
		}
	}
	return observeTransportError(err, opCtx)
}
