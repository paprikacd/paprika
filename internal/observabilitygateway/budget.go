package observabilitygateway

import (
	"context"
	"errors"
	"sync"
	"time"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// These limits apply before Kubernetes reads or provider I/O. A rate limit
// alone does not bound memory when a backend accepts requests but never replies.
const (
	queryTimeout       = 30 * time.Second
	maxConcurrentQuery = 4
	queryQueueWait     = 5 * time.Second
	maxConcurrentQueue = 32
	maxProviderQueue   = 8
	maxQueryWindow     = 31 * 24 * time.Hour
	maxQueryResults    = 1000
	maxQueryBytes      = 32 << 10
)

type providerWorkSlots struct {
	active  chan struct{}
	waiting chan struct{}
	refs    int
}

// executionBudget bounds all provider I/O and isolates each provider behind
// its own bulkhead. Only bounded FIFO waiters hold connections; no detached
// background work survives a client disconnect.
type executionBudget struct {
	active             chan struct{}
	waiting            chan struct{}
	timeout            time.Duration
	queueTimeout       time.Duration
	perProvider        int
	perProviderWaiting int

	mu        sync.Mutex
	providers map[string]*providerWorkSlots
}

func newExecutionBudget(concurrency int, timeout time.Duration) *executionBudget {
	if concurrency < 1 {
		concurrency = 1
	}
	return &executionBudget{
		active:             make(chan struct{}, concurrency),
		waiting:            make(chan struct{}, maxConcurrentQueue),
		timeout:            timeout,
		queueTimeout:       queryQueueWait,
		perProvider:        min(2, concurrency),
		perProviderWaiting: maxProviderQueue,
		providers:          make(map[string]*providerWorkSlots),
	}
}

func (b *executionBudget) providerSlots(provider string) *providerWorkSlots {
	b.mu.Lock()
	defer b.mu.Unlock()
	slots := b.providers[provider]
	if slots == nil {
		slots = &providerWorkSlots{
			active:  make(chan struct{}, b.perProvider),
			waiting: make(chan struct{}, b.perProviderWaiting),
		}
		b.providers[provider] = slots
	}
	slots.refs++
	return slots
}

func (b *executionBudget) releaseProvider(provider string, slots *providerWorkSlots) {
	b.mu.Lock()
	defer b.mu.Unlock()
	slots.refs--
	if slots.refs == 0 {
		delete(b.providers, provider)
	}
}

func waitForQuerySlot(ctx context.Context, active, waiting chan struct{}) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	select {
	case active <- struct{}{}:
		if err := contextError(ctx); err != nil {
			<-active
			return err
		}
		return nil
	default:
	}
	select {
	case waiting <- struct{}{}:
		defer func() { <-waiting }()
	default:
		return connect.NewError(connect.CodeResourceExhausted,
			errors.New("observability query queue is full; retry shortly"))
	}
	select {
	case active <- struct{}{}:
		if err := contextError(ctx); err != nil {
			<-active
			return err
		}
		return nil
	case <-ctx.Done():
		return contextError(ctx)
	}
}

// begin acquires per-provider execution before the global cap, so a noisy
// provider cannot occupy every worker. Queue wait and execution budgets are
// separate, and both inherit the caller's earlier deadline/cancellation.
func (b *executionBudget) begin(ctx context.Context, provider string) (context.Context, func(), error) {
	if err := contextError(ctx); err != nil {
		return nil, nil, err
	}
	queueCtx, stop := context.WithTimeout(ctx, b.queueTimeout)
	defer stop()
	slots := b.providerSlots(provider)
	providerAcquired, globalAcquired := false, false
	release := func() {
		if globalAcquired {
			<-b.active
		}
		if providerAcquired {
			<-slots.active
		}
		b.releaseProvider(provider, slots)
	}
	if err := waitForQuerySlot(queueCtx, slots.active, slots.waiting); err != nil {
		release()
		return nil, nil, err
	}
	providerAcquired = true
	if err := waitForQuerySlot(queueCtx, b.active, b.waiting); err != nil {
		release()
		return nil, nil, err
	}
	globalAcquired = true
	bounded, cancel := context.WithTimeout(ctx, b.timeout)
	if err := contextError(bounded); err != nil {
		cancel()
		release()
		return nil, nil, err
	}
	var once sync.Once
	return bounded, func() {
		once.Do(func() {
			cancel()
			release()
		})
	}, nil
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
