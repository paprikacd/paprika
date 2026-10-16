// Package gcpcloudmonitoring implements connector.Connector for Google
// Cloud Monitoring's timeSeries API. Only the metrics signal is served, and
// queries carry the Monitoring filter expression, e.g.
// metric.type="custom.googleapis.com/foo".
//
// The timeSeries API requires an interval, so a zero QueryRequest.Range
// bound is not omitted: it defaults the window to the trailing hour. An
// empty Query switches to the probe path — one metricDescriptors call, the
// lightest possible — since there is no meaningful unfiltered timeSeries
// query.
package gcpcloudmonitoring

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

// Cloud Monitoring API paths, page-size shaping and the default window the
// interval falls back to when a range bound is zero — the timeSeries API
// rejects an absent interval outright, so unbounded cannot be expressed.
const (
	defaultEndpoint = "https://monitoring.googleapis.com"
	defaultLimit    = 100
	probeLimit      = 1
	maxLimit        = 1000
	defaultWindow   = time.Hour
)

// CloudMonitoring is a connector for Google Cloud Monitoring. It is a
// stateless struct; per-call state travels in connector.QueryRequest.
type CloudMonitoring struct{}

// New returns a Cloud Monitoring connector.
func New() connector.Connector { return CloudMonitoring{} }

// Descriptor advertises name, signals and network needs.
func (CloudMonitoring) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderGCPCloudMonitoring,
		Signals:     []connector.Signal{connector.SignalMetrics},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// projectId, endpoint and insecureSkipTLS keys — ahead of use.
func (CloudMonitoring) ValidateConfig(config json.RawMessage) error {
	if err := gcpcommon.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one timeSeries request against the project's metrics, bounded
// by the request range. An empty Query is the probe path: a single
// metricDescriptors page instead, the lightest call the API offers.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudMonitoring) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if reason := queryShapeError(&req); reason != "" {
		return unsupported(reason)
	}
	filter, err := gcpcommon.PrepareFilter(req.Query, false)
	if err != nil {
		return unsupported(err.Error())
	}
	req.Query = filter
	cfg, err := gcpcommon.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudmonitoring: %w", err)
	}
	project, err := gcpcommon.ResolveProject(cfg.ProjectID, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	client, err := gcpcommon.Client(ctx, req.Credentials, cfg.InsecureSkipTLS)
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
	if req.Signal != connector.SignalMetrics {
		return "gcp-cloudmonitoring connector supplies metrics only"
	}
	if req.TraceID != "" {
		return "a trace ID cannot be fetched from cloud monitoring"
	}
	if hasProjectSelector(req.Query) {
		return "the provider fixes the Monitoring project; omit a project selector"
	}
	return ""
}

// requestShape picks the API path and query values for one request: a
// timeSeries query with the interval defaulted to a trailing-hour window,
// or the probe's single metricDescriptors page when the filter is empty.
func requestShape(project string, req *connector.QueryRequest) (string, url.Values) {
	if req.Query == "" {
		return metricDescriptorsPath(project), url.Values{
			"pageSize": []string{strconv.Itoa(probeLimit)},
			"filter":   []string{projectFilter(project, "")},
		}
	}

	// The timeSeries API requires an interval: a zero bound defaults to a
	// trailing-hour window rather than being omitted, since the API would
	// reject the call outright.
	end := req.Range.End
	if end.IsZero() {
		end = time.Now()
	}
	start := req.Range.Start
	if start.IsZero() {
		start = end.Add(-defaultWindow)
	}
	return timeSeriesPath(project), url.Values{
		"filter":             []string{projectFilter(project, req.Query)},
		"interval.startTime": []string{start.Format(time.RFC3339)},
		"interval.endTime":   []string{end.Format(time.RFC3339)},
		"pageSize":           []string{strconv.Itoa(httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit))},
		"view":               []string{"FULL"},
	}
}

// A projects/<id> path selects a metrics scope, which can include linked
// projects. Pin the data's own project as a separate selector too, including
// descriptor discovery and health probes. Parentheses keep caller ORs inside
// that project boundary. See https://cloud.google.com/monitoring/api/v3/filters.
func projectFilter(project, filter string) string {
	selector := fmt.Sprintf("project = %q", project)
	if filter == "" {
		return selector
	}
	return selector + " AND (" + filter + ")"
}

// Monitoring's grammar groups project comparisons into one selector using
// OR. Reject caller project selectors rather than intermingling two project
// selectors with AND or letting callers replace the provider's boundary.
// Values inside strings and resource/metric label paths are not selectors.
func hasProjectSelector(filter string) bool {
	for i := 0; i < len(filter); {
		ch := filter[i]
		if ch == '"' {
			i = skipQuotedValue(filter, i+1)
			continue
		}
		if isIdentifierByte(ch) {
			start := i
			for i < len(filter) && isIdentifierByte(filter[i]) {
				i++
			}
			if filter[start:i] == "project" {
				return true
			}
			continue
		}
		i++
	}
	return false
}

func skipQuotedValue(filter string, start int) int {
	for i := start; i < len(filter); i++ {
		switch filter[i] {
		case '\\':
			i++ // Escaped quotes and backslashes stay inside the value.
		case '"':
			return i + 1
		}
	}
	return len(filter)
}

func isIdentifierByte(ch byte) bool {
	return ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '.'
}

// timeSeriesPath and metricDescriptorsPath are the per-project Monitoring
// API paths; both are collection-style GETs under /v3.
func timeSeriesPath(project string) string {
	return "/v3/projects/" + project + "/timeSeries"
}

func metricDescriptorsPath(project string) string {
	return "/v3/projects/" + project + "/metricDescriptors"
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
	return result, fmt.Errorf("gcp-cloudmonitoring: %w", credErr)
}
