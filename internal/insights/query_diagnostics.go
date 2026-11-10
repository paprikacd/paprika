package insights

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// QueryDiagnostics is a bounded execution receipt. It never contains provider
// endpoints, headers, credentials, query text or variable values. All durations
// belong to one Insights execution; the browser and provider have separate clocks.
type QueryDiagnostics struct {
	Version     int                    `json:"version"`
	ExecutionID string                 `json:"executionId"`
	Outcome     string                 `json:"outcome"`
	Source      QueryDiagnosticSource  `json:"source"`
	Requested   QueryDiagnosticBounds  `json:"requested"`
	Effective   QueryEffectiveBounds   `json:"effective"`
	Phases      []QueryDiagnosticPhase `json:"phases"`
	TotalMs     float64                `json:"totalMs"`
	Counts      *QueryResultCounts     `json:"counts,omitempty"`
	Truncated   bool                   `json:"truncated"`
}

// QueryDiagnosticSource exposes only the authorized public source identity.
type QueryDiagnosticSource struct {
	ProviderID   string `json:"providerId"`
	ProviderType string `json:"providerType"`
	Transport    string `json:"transport"`
}

// QueryDiagnosticBounds uses Unix seconds, like Query. Step is also in seconds.
type QueryDiagnosticBounds struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Step  float64 `json:"step"`
}

// QueryEffectiveBounds describes bounds sent by Insights, not inferred provider
// behavior. A gateway scope cannot prove the final provider's effective bounds.
// Trace detail is not constrained by the dashboard's search window.
type QueryEffectiveBounds struct {
	Start        *float64 `json:"start,omitempty"`
	End          *float64 `json:"end,omitempty"`
	Step         *float64 `json:"step,omitempty"`
	Dispatched   bool     `json:"dispatched"`
	RangeApplied bool     `json:"rangeApplied"`
	Scope        string   `json:"scope"`
}

// QueryDiagnosticPhase distinguishes exclusive service intervals from nested
// provider work. A null duration is unknown, never a zero-cost observation.
type QueryDiagnosticPhase struct {
	Name         string   `json:"name"`
	Owner        string   `json:"owner"`
	Clock        string   `json:"clock"`
	DurationMs   *float64 `json:"durationMs"`
	Relationship string   `json:"relationship"`
	Parent       string   `json:"parent,omitempty"`
}

// QueryResultCounts describes returned, normalized data. It is neither input
// cardinality, evaluator sample accounting, physical storage work nor billing.
type QueryResultCounts struct {
	Series int `json:"series"`
	Points int `json:"points"`
	Traces int `json:"traces"`
	Spans  int `json:"spans"`
	Rows   int `json:"rows"`
}

// A query has one sequential normalization boundary, after the complete
// upstream response has arrived. Retries and gateway protocol processing are
// part of upstream work. No provider execution or network transfer is inferred.
type queryMeasurement struct {
	normalizationStarted time.Time
	dispatched           bool
}

func (m *queryMeasurement) dispatch() {
	if m != nil {
		m.dispatched = true
	}
}

func (m *queryMeasurement) normalize() {
	if m != nil {
		m.normalizationStarted = time.Now()
	}
}

func newQueryDiagnostics(p *providerClient, q *Query) *QueryDiagnostics {
	transport, scope := "direct", "provider"
	if p.remote != nil {
		transport, scope = "gateway", "gateway"
	}
	return &QueryDiagnostics{
		Version: 1, ExecutionID: rand.Text(), Outcome: "success",
		Source:    QueryDiagnosticSource{ProviderID: p.public.ID, ProviderType: p.public.Type, Transport: transport},
		Requested: QueryDiagnosticBounds{Start: q.Start, End: q.End, Step: q.Step},
		Effective: QueryEffectiveBounds{Scope: scope},
		Phases:    make([]QueryDiagnosticPhase, 0, 4),
	}
}

func effectiveQueryBounds(p *providerClient, q *Query, scope string) QueryEffectiveBounds {
	effective := QueryEffectiveBounds{Scope: scope, Dispatched: true, RangeApplied: q.TraceID == ""}
	if !effective.RangeApplied {
		return effective
	}
	start, end := q.Start, q.End
	if p.remote == nil && q.Kind == "traces" {
		start, end = float64(int64(start)), float64(int64(end))
	}
	effective.Start, effective.End = &start, &end
	if q.Kind == "metrics" {
		step := q.Step
		effective.Step = &step
	}
	return effective
}

func (d *QueryDiagnostics) phase(name string, duration time.Duration) {
	ms := duration.Seconds() * 1000
	d.Phases = append(d.Phases, QueryDiagnosticPhase{
		Name: name, Owner: "insights", Clock: "server-monotonic",
		DurationMs: &ms, Relationship: "exclusive",
	})
}

func (d *QueryDiagnostics) complete(result *QueryResult, err error) {
	if err != nil {
		switch queryFailureDetails(err).Code {
		case "canceled":
			d.Outcome = "cancelled"
		case "timeout":
			d.Outcome = "timeout"
		case "rate_limited":
			d.Outcome = "capacity"
		default:
			d.Outcome = "error"
		}
		return
	}
	d.Truncated = result.Truncated
	if result.Truncated {
		d.Outcome = "partial"
	}
	d.Counts = returnedQueryCounts(result)
}

func returnedQueryCounts(result *QueryResult) *QueryResultCounts {
	counts := &QueryResultCounts{Series: len(result.Series), Traces: len(result.Traces), Spans: len(result.Spans)}
	for _, series := range result.Series {
		counts.Points += len(series.Points)
	}
	if result.Records != nil {
		counts.Rows = len(result.Records.Rows)
	}
	return counts
}

func queryFailureDetails(err error) *DashboardQueryError {
	var remote *observeError
	if errors.As(err, &remote) && remote.status == http.StatusRequestTimeout {
		return &DashboardQueryError{Code: "canceled", Message: "The provider query was canceled."}
	}
	var direct *providerHTTPError
	if errors.As(err, &direct) {
		switch direct.status {
		case http.StatusRequestTimeout, http.StatusGatewayTimeout:
			return &DashboardQueryError{Code: "timeout", Message: "The provider query exceeded its time budget."}
		case http.StatusTooManyRequests:
			return &DashboardQueryError{Code: "rate_limited", Message: "Query capacity is currently exhausted; retry shortly."}
		}
	}
	return dashboardProviderError(err)
}

func writeQueryFailure(w http.ResponseWriter, err error, diagnostics *QueryDiagnostics) {
	failure := queryFailureDetails(err)
	status := queryFailureStatus(err, failure.Code)
	if status == http.StatusTooManyRequests {
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, status, struct {
		Error       string            `json:"error"`
		Code        string            `json:"code"`
		Diagnostics *QueryDiagnostics `json:"diagnostics,omitempty"`
	}{Error: failure.Message, Code: failure.Code, Diagnostics: diagnostics})
}

func queryFailureStatus(err error, code string) int {
	switch code {
	case "canceled":
		return http.StatusRequestTimeout
	case "timeout":
		return http.StatusGatewayTimeout
	case "rate_limited":
		return http.StatusTooManyRequests
	case "provider_not_found":
		return http.StatusNotFound
	}
	var remote *observeError
	if errors.As(err, &remote) {
		return remote.status
	}
	return http.StatusBadGateway
}

// Preserve cancellation and timeout identity without wrapping an HTTP error
// whose message can contain a provider URL, query expression or credentials.
func safeProviderTransportError(ctx context.Context, err error) error {
	if cause := ctx.Err(); cause != nil {
		return fmt.Errorf("provider request context: %w", cause)
	}
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("provider request context: %w", context.Canceled)
	}
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return fmt.Errorf("provider request timeout: %w", context.DeadlineExceeded)
	}
	return errUpstream
}
