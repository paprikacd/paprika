// Package loki implements connector.Connector for Grafana Loki's query
// API. Only the logs signal is served, and queries carry LogQL.
//
// Loki's query_range requires start and end, so callers should always set
// QueryRequest.Range; a zero bound is translated into an omitted parameter
// and the backend's rejection then surfaces as a StateError result, which
// is the honest report of what happened.
package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Loki HTTP API path and limit shaping. Loki's limit parameter tops out in
// practice well below its documented maximum, but 1000 keeps any single
// request bounded.
const (
	pathQueryRange = "/loki/api/v1/query_range"
	defaultLimit   = 100
	maxLimit       = 1000
)

// Loki is a connector for Grafana Loki. It is a stateless struct; per-call
// state travels in connector.QueryRequest.
type Loki struct{}

// New returns a Loki connector.
func New() connector.Connector { return Loki{} }

// Descriptor advertises name, signals and network needs.
func (Loki) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderLoki,
		Signals:     []connector.Signal{connector.SignalLogs},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// endpoint, headers and insecureSkipTLS keys — ahead of use.
func (Loki) ValidateConfig(config json.RawMessage) error {
	if err := httphelp.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one LogQL query against the range endpoint, newest first, with
// start and end expressed in nanoseconds as Loki expects.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Loki) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalLogs {
		return unsupported("loki connector supplies logs only")
	}
	if req.Query == "" {
		return unsupported("a LogQL query expression is required")
	}
	cfg, err := httphelp.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("loki: %w", err)
	}

	params := url.Values{
		"query":     []string{req.Query},
		"limit":     []string{strconv.Itoa(httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit))},
		"direction": []string{"backward"},
	}
	if !req.Range.Start.IsZero() {
		params.Set("start", strconv.FormatInt(req.Range.Start.UnixNano(), 10))
	}
	if !req.Range.End.IsZero() {
		params.Set("end", strconv.FormatInt(req.Range.End.UnixNano(), 10))
	}

	data, err := httphelp.Get(ctx, cfg, pathQueryRange, params, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
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
