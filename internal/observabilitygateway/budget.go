package observabilitygateway

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// These limits apply before Kubernetes reads or provider I/O. A rate limit
// alone does not bound memory when a backend accepts requests but never replies.
const (
	queryTimeout       = 30 * time.Second
	maxConcurrentQuery = 4
	maxQueryWindow     = 31 * 24 * time.Hour
	maxQueryResults    = 1000
	maxQueryBytes      = 32 << 10
)

type executionBudget struct {
	active  chan struct{}
	timeout time.Duration
}

func newExecutionBudget(concurrency int, timeout time.Duration) *executionBudget {
	return &executionBudget{active: make(chan struct{}, concurrency), timeout: timeout}
}

// begin rejects excess work immediately instead of maintaining an unbounded
// queue. WithTimeout retains any earlier caller deadline and cancellation.
func (b *executionBudget) begin(ctx context.Context) (context.Context, func(), error) {
	if err := contextError(ctx); err != nil {
		return nil, nil, err
	}
	select {
	case b.active <- struct{}{}:
		bounded, cancel := context.WithTimeout(ctx, b.timeout)
		return bounded, func() { cancel(); <-b.active }, nil
	default:
		return nil, nil, connect.NewError(connect.CodeResourceExhausted,
			errors.New("observability gateway is at its concurrent query limit; retry later"))
	}
}

func contextError(ctx context.Context) error {
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return connect.NewError(connect.CodeCanceled, errors.New("observability request canceled"))
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, errors.New("observability request exceeded its time budget"))
	default:
		return nil
	}
}

func validateWindow(window connector.TimeRange) error {
	if window.Start.IsZero() || window.End.IsZero() {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("both start and end are required for a bounded query"))
	}
	if !window.End.After(window.Start) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("end must be after start"))
	}
	if window.End.Sub(window.Start) > maxQueryWindow {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("query window must not exceed 31 days"))
	}
	return nil
}

func boundQuery(req *connector.QueryRequest) error {
	if err := validateQueryInputs(req); err != nil {
		return err
	}
	defaultWindow(&req.Range)
	if err := validateWindow(req.Range); err != nil {
		return err
	}
	if err := validateQueryStep(req); err != nil {
		return err
	}
	limit, err := boundedLimit(req.Limit, 100)
	req.Limit = limit
	return err
}

func validateQueryInputs(req *connector.QueryRequest) error {
	if len(req.PageToken) > 4096 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("page_token exceeds its size limit"))
	}
	if req.PageToken != "" && (req.Range.Start.IsZero() || req.Range.End.IsZero()) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("page_token requires explicit start and end matching the original query"))
	}
	if len(req.Query) > maxQueryBytes || len(req.TraceID) > 256 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("query expression or trace ID exceeds its size limit"))
	}
	return nil
}

func defaultWindow(window *connector.TimeRange) {
	if window.End.IsZero() {
		window.End = time.Now().UTC()
	}
	if window.Start.IsZero() {
		window.Start = window.End.Add(-defaultQueryWindow)
	}
}

func validateQueryStep(req *connector.QueryRequest) error {
	if req.Step < 0 || req.Step > maxQueryWindow || (req.Step > 0 && req.Step < time.Second) ||
		(!req.Instant && req.Step > 0 && req.Range.End.Sub(req.Range.Start)/req.Step >= 11000) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("step must be between 1 second and 31 days and produce at most 11000 points"))
	}
	return nil
}

func boundedLimit(limit, fallback int) (int, error) {
	if limit < 0 || limit > maxQueryResults {
		return 0, connect.NewError(connect.CodeInvalidArgument, errors.New("limit must be between 1 and 1000"))
	}
	if limit == 0 {
		return fallback, nil
	}
	return limit, nil
}
