// Package gcpcloudtrace implements connector.Connector for Google Cloud
// Trace's REST API. Only the traces signal is served. A request carrying
// TraceID fetches that one trace directly; otherwise a Query runs against
// the trace list as the list filter. An empty Query and no TraceID is the
// probe path: the list with a one-trace page.
package gcpcloudtrace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Cloud Trace API path shape and page-size shaping. pageSize tops out at
// the documented 1000; the probe asks for a single trace.
const (
	defaultEndpoint = "https://cloudtrace.googleapis.com"
	defaultLimit    = 100
	probeLimit      = 1
	maxLimit        = 1000
)

// CloudTrace is a connector for Google Cloud Trace. It is a stateless
// struct; per-call state travels in connector.QueryRequest.
type CloudTrace struct{}

// New returns a Cloud Trace connector.
func New() connector.Connector { return CloudTrace{} }

// Descriptor advertises name, signals and network needs.
func (CloudTrace) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderGCPCloudTrace,
		Signals:     []connector.Signal{connector.SignalTraces},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// projectId, endpoint and insecureSkipTLS keys — ahead of use.
func (CloudTrace) ValidateConfig(config json.RawMessage) error {
	if err := gcpcommon.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query answers a direct trace fetch or a trace list. TraceID wins when both
// it and Query are set: a direct fetch is the more precise interpretation of
// what the caller asked for. An empty Query and no TraceID is the probe
// path: the list with a one-trace page, the lightest call the API offers.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudTrace) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if reason := queryShapeError(&req); reason != "" {
		return unsupported(reason)
	}
	cfg, err := gcpcommon.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudtrace: %w", err)
	}
	project, err := gcpcommon.ResolveProject(cfg.ProjectID, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	client, err := gcpcommon.Client(ctx, cfg, req.Credentials)
	if err != nil {
		result, credErr := credentialError(err)
		return result, credErr
	}

	path, params := requestShape(project, &req)
	if req.PageToken != "" {
		params.Set("pageToken", req.PageToken)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet,
		gcpcommon.URL(cfg, defaultEndpoint, path, params), http.NoBody)
	if err != nil {
		// The URL is not echoed: with a validated endpoint and a fixed path
		// this is unreachable, and if it is reached the message must not
		// carry the endpoint.
		return nil, errors.New("building backend request: invalid endpoint or path")
	}

	data, err := gcpcommon.Do(httpReq, client)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

func queryShapeError(req *connector.QueryRequest) string {
	if len(req.PageToken) > connector.MaxPageTokenBytes {
		return "page token exceeds the maximum size"
	}
	if req.TraceID != "" && req.PageToken != "" {
		return "a page token cannot be used when fetching one trace"
	}
	if req.Signal != connector.SignalTraces {
		return "gcp-cloudtrace connector supplies traces only"
	}
	return ""
}

// requestShape picks the API path and query values for one request. TraceID
// wins over Query — a direct fetch is the more precise interpretation of
// what the caller asked for. An empty Query and no TraceID is the probe
// path: the list with a one-trace page, the lightest call the API offers.
func requestShape(project string, req *connector.QueryRequest) (string, url.Values) {
	if req.TraceID != "" {
		return tracesPath(project) + "/" + url.PathEscape(req.TraceID), nil
	}

	path := tracesPath(project)
	limit := httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit)
	if req.Query == "" {
		limit = probeLimit
	}
	params := url.Values{
		"pageSize": []string{strconv.Itoa(limit)},
	}
	if req.Query != "" {
		params.Set("filter", req.Query)
	}
	if !req.Range.Start.IsZero() {
		params.Set("startTime", req.Range.Start.UTC().Format(time.RFC3339Nano))
	}
	if !req.Range.End.IsZero() {
		params.Set("endTime", req.Range.End.UTC().Format(time.RFC3339Nano))
	}
	return path, params
}

// tracesPath is the per-project Cloud Trace list path; the direct fetch
// appends the escaped trace ID to it.
func tracesPath(project string) string {
	return "/v1/projects/" + project + "/traces"
}

// unsupported builds the result — and error — for a query shape the
// connector does not serve. The result carries the fixed user-facing
// sentence; the error wraps connector.ErrUnsupported so the caller bug can
// be classified programmatically.
func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// queryError converts a backend failure into its sanitized result: the
// State classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func queryError(err error) *connector.QueryResult {
	state := gcpcommon.ClassifyState(err)
	return &connector.QueryResult{State: state, Reason: gcpcommon.ReasonFor(state)}
}

// credentialError maps a credential-construction failure onto the dual
// result+error contract: the fixed user-facing sentence travels in the
// result, connector-wrapped sanitized detail in the error for logs.
func credentialError(err error) (*connector.QueryResult, error) {
	result, credErr := gcpcommon.CredentialError(err)
	return result, fmt.Errorf("gcp-cloudtrace: %w", credErr)
}
