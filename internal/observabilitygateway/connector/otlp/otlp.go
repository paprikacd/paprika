// Package otlp implements connector.Connector as a deliberately generic
// escape hatch for OTLP-compatible retrieval proxies and gateways: an
// in-cluster OpenTelemetry Collector with a custom receiver, or OTLP
// endpoints exposed by observability platforms. It performs a plain HTTP
// GET against the signal's OTLP path and passes through whatever JSON comes
// back. Backend query languages are not supported here — the native
// connectors (prometheus, loki, tempo) exist for those.
//
// The OTLP specification defines export, not retrieval, so the query
// parameters this connector sends are conventions the retrieval proxy is
// expected to interpret: trace_id selects one trace, limit caps entries,
// and start/end are Unix nanoseconds bounding the window.
package otlp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// OTLP signal paths, relative to the configured endpoint. Retrieval
// proxies expose these alongside the standard /v1/* export paths.
const (
	pathLogs    = "/v1/logs"
	pathMetrics = "/v1/metrics"
	pathTraces  = "/v1/traces"
)

// OTLP is a connector for OTLP-compatible retrieval proxies. It is a
// stateless struct; per-call state travels in connector.QueryRequest.
type OTLP struct{}

// New returns an OTLP connector.
func New() connector.Connector { return OTLP{} }

// Descriptor advertises name, signals and network needs. All three signals
// are served because retrieval proxies decide their own semantics.
func (OTLP) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderOTLP,
		Signals:     []connector.Signal{connector.SignalLogs, connector.SignalMetrics, connector.SignalTraces},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// endpoint, headers and insecureSkipTLS keys — ahead of use.
func (OTLP) ValidateConfig(config json.RawMessage) error {
	if err := httphelp.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query performs a GET against the signal's OTLP path. trace_id, limit,
// start and end are sent as query parameters only when set; unlike the
// native connectors, neither Query nor TraceID is required — fetch-by-
// parameters is the intended mode for retrieval proxies.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (OTLP) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	var path string
	switch req.Signal {
	case connector.SignalLogs:
		path = pathLogs
	case connector.SignalMetrics:
		path = pathMetrics
	case connector.SignalTraces:
		path = pathTraces
	case connector.SignalRecords:
		return unsupported("otlp connector does not serve the requested signal")
	default:
		return unsupported("otlp connector does not serve the requested signal")
	}
	cfg, err := httphelp.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("otlp: %w", err)
	}

	data, err := httphelp.Get(ctx, cfg, path, otlpParams(&req), req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// otlpParams builds the retrieval-proxy convention parameters: trace_id
// selects one trace, limit caps entries, and start/end are Unix nanoseconds
// bounding the window. Each is sent only when set.
func otlpParams(req *connector.QueryRequest) url.Values {
	params := url.Values{}
	if req.TraceID != "" {
		params.Set("trace_id", req.TraceID)
	}
	if req.Limit > 0 {
		params.Set("limit", strconv.Itoa(req.Limit))
	}
	if !req.Range.Start.IsZero() {
		params.Set("start", strconv.FormatInt(req.Range.Start.UnixNano(), 10))
	}
	if !req.Range.End.IsZero() {
		params.Set("end", strconv.FormatInt(req.Range.End.UnixNano(), 10))
	}
	return params
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
	state := httphelp.ClassifyState(err)
	return &connector.QueryResult{State: state, Reason: httphelp.ReasonFor(state)}
}
