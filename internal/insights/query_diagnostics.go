package insights

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/benebsworth/paprika/internal/capacityhint"
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
	// TruncationReason is the QueryTruncation.Reason of a truncated result. It
	// is absent when the result is complete.
	TruncationReason string `json:"truncationReason,omitempty"`
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

// queryReceiptHeader opts a /api/query call into receipts. Without it the
// response bodies are exactly the ones Insights has always returned.
const queryReceiptHeader = "X-Insights-Diagnostics"

// queryMeasurement is filled by the provider path. A query has one sequential
// normalization boundary, after the complete upstream response has arrived.
// Retries and gateway protocol processing count as upstream work. dispatched
// is set only when a provider request is about to leave; no provider execution
// time or network transfer is inferred from it.
type queryMeasurement struct {
	normalizationStarted time.Time
	dispatched           atomic.Bool
	// raisedStep is the step Insights dispatched when the provider minimum
	// raised the requested one; zero when the requested step was sent.
	raisedStep float64
}

func (m *queryMeasurement) dispatch() {
	if m != nil {
		m.dispatched.Store(true)
	}
}

// raiseStep records that the dispatched metrics step is step, not the requested one.
func (m *queryMeasurement) raiseStep(step float64) {
	if m != nil {
		m.raisedStep = step
	}
}

func (m *queryMeasurement) normalize() {
	if m != nil {
		m.normalizationStarted = time.Now()
	}
}

// queryReceipt is the clock and ledger of one query execution. Exclusive phases
// are contiguous marks on one monotonic clock, so they reconcile exactly to
// TotalMs. The source and effective bounds are bound once the provider is
// known; a receipt that never binds is never returned to a caller.
type queryReceipt struct {
	query      *Query
	requested  bool
	bound      bool
	dispatched bool
	start      time.Time
	last       time.Time
	diag       *QueryDiagnostics
}

type queryReceiptKey struct{}

func newQueryReceipt(q *Query, requested bool) *queryReceipt {
	now := time.Now()
	return &queryReceipt{
		query: q, requested: requested, start: now, last: now,
		diag: &QueryDiagnostics{
			Version: 1, ExecutionID: rand.Text(), Outcome: "success",
			Requested: QueryDiagnosticBounds{Start: q.Start, End: q.End, Step: q.Step},
			Phases:    make([]QueryDiagnosticPhase, 0, 4),
		},
	}
}

func withQueryReceipt(ctx context.Context, receipt *queryReceipt) context.Context {
	return context.WithValue(ctx, queryReceiptKey{}, receipt)
}

// receiptFrom returns the execution's receipt, or nil. Every method is nil-safe.
func receiptFrom(ctx context.Context) *queryReceipt {
	if receipt, ok := ctx.Value(queryReceiptKey{}).(*queryReceipt); ok {
		return receipt
	}
	return nil
}

// bind records the public source and the bounds scope that the provider path
// will report. A gateway scope cannot prove the final provider's effective bounds.
func (r *queryReceipt) bind(p *providerClient) {
	if r == nil || r.bound {
		return
	}
	transport, scope := "direct", "provider"
	if p.remote != nil {
		transport, scope = "gateway", "gateway"
	}
	r.diag.Source = QueryDiagnosticSource{ProviderID: p.public.ID, ProviderType: p.public.Type, Transport: transport}
	r.diag.Effective = QueryEffectiveBounds{Scope: scope}
	r.bound = true
}

// mark closes the current exclusive phase at now.
func (r *queryReceipt) mark(name string) {
	r.markAt(name, time.Now())
}

func (r *queryReceipt) markAt(name string, at time.Time) {
	if r == nil {
		return
	}
	if at.Before(r.last) {
		at = r.last
	}
	ms := at.Sub(r.last).Seconds() * 1000
	r.diag.Phases = append(r.diag.Phases, QueryDiagnosticPhase{
		Name: name, Owner: "insights", Clock: "server-monotonic",
		DurationMs: &ms, Relationship: "exclusive",
	})
	r.last = at
	r.diag.TotalMs = at.Sub(r.start).Seconds() * 1000
}

// finishExecution closes the provider phases. Upstream work runs until the
// normalization boundary, or until the call ends when none was reached.
func (r *queryReceipt) finishExecution(p *providerClient, measurement *queryMeasurement, finished time.Time, result *QueryResult, err error) {
	if r == nil {
		return
	}
	if measurement.dispatched.Load() {
		r.dispatched = true
		dispatched := r.query
		if measurement.raisedStep > 0 {
			raised := *r.query
			raised.Step = measurement.raisedStep
			dispatched = &raised
		}
		r.diag.Effective = effectiveQueryBounds(p, dispatched, r.diag.Effective.Scope)
	}
	if measurement.normalizationStarted.IsZero() {
		r.markAt("upstream", finished)
	} else {
		r.markAt("upstream", measurement.normalizationStarted)
		r.markAt("normalization", finished)
	}
	if measurement.dispatched.Load() {
		r.diag.Phases = append(r.diag.Phases, QueryDiagnosticPhase{
			Name: "provider", Owner: "provider", Clock: "unavailable", Relationship: "nested", Parent: "upstream",
		})
	}
	r.diag.complete(result, err)
}

// fail records a failure that happened before or outside provider execution.
func (r *queryReceipt) fail(err error) {
	if r != nil {
		r.diag.complete(nil, err)
	}
}

// diagnostics is the receipt the execution path carries, bound or not.
func (r *queryReceipt) diagnostics() *QueryDiagnostics {
	if r == nil {
		return nil
	}
	return r.diag
}

// response is the receipt a caller may see: requested, and bound to a provider.
func (r *queryReceipt) response() *QueryDiagnostics {
	if r == nil || !r.requested || !r.bound {
		return nil
	}
	return r.diag
}

func wantsQueryReceipt(r *http.Request) bool {
	return r.Header.Get(queryReceiptHeader) == "1"
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

func (d *QueryDiagnostics) complete(result *QueryResult, err error) {
	if err != nil {
		switch classifyQueryFailure(err).Code {
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
	if result.Truncation != nil {
		d.TruncationReason = result.Truncation.Reason
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

// writeQueryFailure answers a failed query. The status and fixed message are the
// ones Insights has always returned. Every failure carries its machine code, and
// a receipt, when present, adds the diagnostics beside the same error text.
func writeQueryFailure(w http.ResponseWriter, err error, diagnostics *QueryDiagnostics) {
	status, message := queryErrorResponse(err)
	if status == http.StatusTooManyRequests {
		// A gateway's own delay wins; otherwise the local pool's estimate, else the floor.
		retryAfter := capacityhint.MinSeconds
		var remote *observeError
		var refusal *capacityRefusal
		switch {
		case errors.As(err, &remote) && remote.retryAfter > 0:
			retryAfter = remote.retryAfter
		case errors.As(err, &refusal) && refusal.retryAfter > 0:
			retryAfter = refusal.retryAfter
		}
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	code := classifyQueryFailure(err).Code
	if diagnostics == nil {
		writeJSON(w, status, map[string]string{"error": message, "code": code})
		return
	}
	writeJSON(w, status, struct {
		Error       string            `json:"error"`
		Code        string            `json:"code"`
		Diagnostics *QueryDiagnostics `json:"diagnostics"`
	}{Error: message, Code: code, Diagnostics: diagnostics})
}

// queryErrorResponse maps a failed query phase to its status and message. The
// deadline names the query; other provider failures keep the shared text.
func queryErrorResponse(err error) (status int, message string) {
	switch {
	case errors.Is(err, errQueryCapacity):
		return http.StatusTooManyRequests, "too many active queries; retry shortly"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "query exceeded its time budget"
	}
	return providerErrorResponse(err)
}
