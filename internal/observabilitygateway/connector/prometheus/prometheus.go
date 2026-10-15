// Package prometheus implements connector.Connector for
// Prometheus-compatible query APIs — Prometheus itself and the queriers
// that expose its HTTP API (Mimir, Thanos, VictoriaMetrics). Only the
// metrics signal is served, and queries carry PromQL.
package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Prometheus HTTP API paths and range-query step shaping. The step is one
// two hundred fiftieth of the requested span, clamped so both tiny and huge
// ranges stay readable and cheap; a config-document override replaces the
// derived value (see configKeyStep).
const (
	pathInstantQuery = "/api/v1/query"
	pathRangeQuery   = "/api/v1/query_range"
	rangeStepDivisor = 250
	minRangeStep     = 10 * time.Second
	maxRangeStep     = time.Hour
	maxRangePoints   = 11000
	defaultLimit     = 100
	maxLimit         = 1000
)

// configKeyStep is the prometheus-only configuration key: a Go duration
// overriding the derived range-query step. It is validated here, not in
// httphelp, so the same key stays an unknown-key error on every other
// connector.
const configKeyStep = "step"

// prometheusConfig pairs the shared connector configuration with the
// prometheus-only step override; a zero step means "derive from the
// requested range".
type prometheusConfig struct {
	httphelp.Config
	step time.Duration
}

// Prometheus is a connector for Prometheus-compatible query APIs. It is a
// stateless struct; per-call state travels in connector.QueryRequest.
type Prometheus struct{}

// New returns a Prometheus connector.
func New() connector.Connector { return Prometheus{} }

// Descriptor advertises name, signals and network needs.
func (Prometheus) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderPrometheus,
		Signals:     []connector.Signal{connector.SignalMetrics},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// endpoint, headers and insecureSkipTLS keys plus the prometheus-only step
// override — ahead of use.
func (Prometheus) ValidateConfig(config json.RawMessage) error {
	if _, err := parseConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one PromQL query. A range with both Start and End set is
// answered by /api/v1/query_range with a derived step; anything else is an
// instant query evaluated at Range.End when that is set.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Prometheus) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalMetrics {
		return unsupported("prometheus connector supplies metrics only")
	}
	if req.Query == "" {
		return unsupported("a PromQL query expression is required")
	}
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("prometheus: %w", err)
	}

	params := url.Values{"query": []string{req.Query}}
	params.Set("limit", strconv.Itoa(httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit)))
	path := pathInstantQuery
	if !req.Range.Start.IsZero() && !req.Range.End.IsZero() {
		path = pathRangeQuery
		params.Set("start", strconv.FormatInt(req.Range.Start.Unix(), 10))
		params.Set("end", strconv.FormatInt(req.Range.End.Unix(), 10))
		params.Set("step", rangeStep(req.Range))
		if cfg.step > 0 {
			params.Set("step", cfg.step.String())
		}
		step, _ := time.ParseDuration(params.Get("step"))
		if req.Range.End.Before(req.Range.Start) || (step > 0 && req.Range.End.Sub(req.Range.Start)/step >= maxRangePoints) {
			return unsupported("query range and step exceed the maximum of 11000 points per series")
		}
	} else if !req.Range.End.IsZero() {
		params.Set("time", strconv.FormatInt(req.Range.End.Unix(), 10))
	}

	data, err := httphelp.Get(ctx, cfg.Config, path, params, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// parseConfig decodes the prometheus connector configuration: the shared
// strict document with the "step" key additionally allowed, and the step
// itself decoded and validated here.
func parseConfig(config json.RawMessage) (prometheusConfig, error) {
	cfg, err := httphelp.ParseConfigWithKeys(config, []string{configKeyStep})
	if err != nil {
		return prometheusConfig{}, fmt.Errorf("config: %w", err)
	}
	step, err := decodeStep(config)
	if err != nil {
		return prometheusConfig{}, err
	}
	return prometheusConfig{Config: cfg, step: step}, nil
}

// decodeStep reads the prometheus-only "step" key: a Go duration in
// (0, 1h] overriding the derived range-query step. An absent key is a zero
// duration, meaning "derive". The value itself is never echoed — errors
// name the key only, per the shared sanitizing discipline.
func decodeStep(config json.RawMessage) (time.Duration, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(config, &raw); err != nil {
		return 0, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	value, ok := raw[configKeyStep]
	if !ok {
		return 0, nil
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return 0, fmt.Errorf("config: key %q must be a string", configKeyStep)
	}
	step, err := time.ParseDuration(text)
	if err != nil || step <= 0 || step > maxRangeStep {
		return 0, fmt.Errorf("config: key %q must be a Go duration greater than 0 and at most 1h", configKeyStep)
	}
	return step, nil
}

// rangeStep derives the Prometheus step from the requested range: one two
// hundred fiftieth of the span, clamped to [10s, 1h].
func rangeStep(r connector.TimeRange) string {
	step := r.End.Sub(r.Start) / rangeStepDivisor
	if step < minRangeStep {
		step = minRangeStep
	}
	if step > maxRangeStep {
		step = maxRangeStep
	}
	return step.String()
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
