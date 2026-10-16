// Package tempo implements connector.Connector for Grafana Tempo's HTTP
// API. Only the traces signal is served. A request carrying TraceID fetches
// that one trace; otherwise a Query runs against the search endpoint with
// start and end in Unix seconds, as Tempo expects.
package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Tempo HTTP API paths and search limit shaping.
const (
	pathTraceByID = "/api/traces"
	pathSearch    = "/api/search"
	defaultLimit  = 20
	maxLimit      = 100
)

// Tempo is a connector for Grafana Tempo. It is a stateless struct;
// per-call state travels in connector.QueryRequest.
type Tempo struct{}

// New returns a Tempo connector.
func New() connector.Connector { return Tempo{} }

// Descriptor advertises name, signals and network needs.
func (Tempo) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderTempo,
		Signals:     []connector.Signal{connector.SignalTraces},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// endpoint, headers and insecureSkipTLS keys — ahead of use.
func (Tempo) ValidateConfig(config json.RawMessage) error {
	if err := httphelp.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query answers a trace fetch or a search. TraceID wins when both it and
// Query are set: a direct fetch is the more precise interpretation of what
// the caller asked for.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Tempo) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalTraces {
		return unsupported("tempo connector supplies traces only")
	}
	cfg, err := httphelp.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("tempo: %w", err)
	}

	var path string
	var params url.Values
	switch {
	case req.TraceID != "":
		path = pathTraceByID + "/" + url.PathEscape(req.TraceID)
	case req.Query != "":
		path = pathSearch
		params = url.Values{
			"q":     []string{req.Query},
			"limit": []string{strconv.Itoa(httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit))},
		}
		// Tempo's search API bounds its window in unix SECONDS (verified
		// against the backend: nanosecond bounds are rejected with a 400
		// "invalid start" ParseInt range error).
		if !req.Range.Start.IsZero() {
			params.Set("start", strconv.FormatInt(req.Range.Start.Unix(), 10))
		}
		if !req.Range.End.IsZero() {
			params.Set("end", strconv.FormatInt(req.Range.End.Unix(), 10))
		}
	default:
		return unsupported("a trace ID or search query is required")
	}

	data, err := httphelp.Get(ctx, cfg, path, params, req.Credentials)
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
