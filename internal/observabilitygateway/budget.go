package observabilitygateway

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/benebsworth/paprika/internal/capacityhint"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// These limits apply before Kubernetes reads or provider I/O. A rate limit
// alone does not bound memory when a backend accepts requests but never replies.
const (
	queryTimeout = 30 * time.Second
	// The execution-budget defaults. DefaultBudgetConfig returns them, and the
	// gateway's flags default to the same values (cmd/main_observability_gateway.go).
	maxConcurrentQuery = 4
	queryQueueWait     = 5 * time.Second
	maxConcurrentQueue = 32
	maxProviderQueue   = 8
	maxQueryWindow     = 31 * 24 * time.Hour
	maxQueryResults    = 1000
	maxQueryBytes      = 32 << 10
	// maxHoldEstimators bounds the per-provider hold estimators. A provider past
	// the bound is hinted from the budget-wide estimator, never dropped silently.
	maxHoldEstimators = 256
)

// catalogBudgetProvider is the budget class of a provider listing (ListProviders).
// A listing is a fast catalog read, not a provider query, so its hold times stay
// out of the estimators that size query refusals.
const catalogBudgetProvider = "catalog"

// RequestTimeout is the execution budget a query gets once it is admitted: the
// timer in executionBudget.begin starts after the queue wait. A query's worst
// case through this budget is QueueWait + RequestTimeout. The REST dashboard
// handler applies RequestTimeout, or the caller's shorter ObserveBudgetHeader,
// to the whole request, queue wait included (dashboard_api.go, dashboardHandler),
// so its worst case is that deadline.
const RequestTimeout = queryTimeout

// BudgetConfig sizes the execution budget that bounds all provider I/O. When a
// zero field is built into a budget, Concurrency, ProviderConcurrency and
// QueueWait fall back to their defaults, because zero is never a usable value
// for them. Queue and ProviderQueue are taken as given: zero means no waiters.
// The gateway's startup validation (cmd/main_observability_gateway.go) checks
// flag values with their flag names in the errors, and starts from
// DefaultBudgetConfig, so a flag-built config is always complete.
type BudgetConfig struct {
	Concurrency         int           // queries executing at once, across all providers
	ProviderConcurrency int           // queries executing at once per provider
	Queue               int           // waiters across all providers
	ProviderQueue       int           // waiters per provider
	QueueWait           time.Duration // longest a waiter holds its place before a resource_exhausted retry hint
}

// DefaultBudgetConfig returns the gateway's built-in budget. Per-provider
// concurrency is min(2, Concurrency), so it is 2 at the default of 4.
func DefaultBudgetConfig() BudgetConfig {
	return BudgetConfig{
		Concurrency:         maxConcurrentQuery,
		ProviderConcurrency: min(2, maxConcurrentQuery),
		Queue:               maxConcurrentQueue,
		ProviderQueue:       maxProviderQueue,
		QueueWait:           queryQueueWait,
	}
}

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
	admitted           chan struct{}
	timeout            time.Duration
	queueTimeout       time.Duration
	perProvider        int
	perProviderWaiting int

	// hold estimates how long a query holds a global execution slot. It sizes
	// the RetryInfo on refusals, so a busy gateway names a computed retry. Catalog
	// listings are not observed here (see catalogBudgetProvider).
	hold capacityhint.Estimator

	// clock reads the time a slot is held for. It is time.Now except in tests.
	clock func() time.Time

	mu        sync.Mutex
	providers map[string]*providerWorkSlots
	// holds estimates how long a query holds a slot of each provider. It outlives
	// the provider's refs, so a provider that goes idle keeps its own estimate
	// and does not fall back to the budget-wide average.
	holds map[string]*capacityhint.Estimator
}

func newExecutionBudget(concurrency int, timeout time.Duration) *executionBudget {
	cfg := DefaultBudgetConfig()
	cfg.Concurrency = max(1, concurrency)
	cfg.ProviderConcurrency = min(2, cfg.Concurrency)
	return newExecutionBudgetFromConfig(cfg, timeout)
}

// newExecutionBudgetFromConfig builds the budget from a validated config. A
// nonpositive concurrency is clamped to one, so a bad caller cannot build a
// budget that admits nothing.
func newExecutionBudgetFromConfig(cfg BudgetConfig, timeout time.Duration) *executionBudget {
	defaults := DefaultBudgetConfig()
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = defaults.Concurrency
	}
	if cfg.ProviderConcurrency <= 0 {
		cfg.ProviderConcurrency = min(2, cfg.Concurrency)
	}
	if cfg.QueueWait <= 0 {
		cfg.QueueWait = defaults.QueueWait
	}
	concurrency := cfg.Concurrency
	providerConcurrency := max(1, min(cfg.ProviderConcurrency, concurrency))
	return &executionBudget{
		active:             make(chan struct{}, concurrency),
		waiting:            make(chan struct{}, max(0, cfg.Queue)),
		admitted:           make(chan struct{}, concurrency+max(0, cfg.Queue)),
		timeout:            timeout,
		queueTimeout:       cfg.QueueWait,
		perProvider:        providerConcurrency,
		perProviderWaiting: max(0, cfg.ProviderQueue),
		clock:              time.Now,
		providers:          make(map[string]*providerWorkSlots),
		holds:              make(map[string]*capacityhint.Estimator),
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

// retryDelay is the RetryInfo delay for a refusal with ahead requests in front
// of it, computed from the slot hold times observed on est.
func retryDelay(est *capacityhint.Estimator, ahead, slots int) time.Duration {
	return time.Duration(est.Seconds(ahead, slots)) * time.Second
}

// holdFor returns the hold estimator of a provider, creating it on first use. It
// returns nil once maxHoldEstimators providers have one.
func (b *executionBudget) holdFor(provider string) *capacityhint.Estimator {
	b.mu.Lock()
	defer b.mu.Unlock()
	if est := b.holds[provider]; est != nil {
		return est
	}
	if len(b.holds) >= maxHoldEstimators {
		return nil
	}
	est := new(capacityhint.Estimator)
	b.holds[provider] = est
	return est
}

// holdLookup returns the provider's existing hold estimator, or nil. It never
// creates one, so a refusal that names an unknown provider adds no state.
func (b *executionBudget) holdLookup(provider string) *capacityhint.Estimator {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.holds[provider]
}

// observeHold records how long a query held a global slot, globally and for its
// provider. A catalog listing is skipped (see catalogBudgetProvider).
func (b *executionBudget) observeHold(provider string, held time.Duration) {
	if provider == catalogBudgetProvider {
		return
	}
	b.hold.Observe(held)
	if est := b.holdFor(provider); est != nil {
		est.Observe(held)
	}
}

// holdSample says whether one begin's provider resolved. Only a slot held for a
// resolved provider feeds the hold estimates: a name that does not resolve would
// otherwise create an estimator per name, and its fast refusal would pull the
// budget-wide estimate down.
type holdSample struct{ resolved atomic.Bool }

type holdSampleKey struct{}

// markProviderResolved records on the context from begin that the provider
// resolved. Callers call it once resolution succeeds, before the query runs.
func markProviderResolved(ctx context.Context) {
	if sample, ok := ctx.Value(holdSampleKey{}).(*holdSample); ok {
		sample.resolved.Store(true)
	}
}

// holdEstimatorFor returns the provider's estimator once it has samples, and the
// budget-wide one until then, so a new provider is not hinted at the floor.
func holdEstimatorFor(provider, budget *capacityhint.Estimator) *capacityhint.Estimator {
	if provider != nil && provider.Average() > 0 {
		return provider
	}
	return budget
}

// resourceExhaustedWithRetry is a retryable refusal that names its retry delay.
func resourceExhaustedWithRetry(message string, delay time.Duration) error {
	err := connect.NewError(connect.CodeResourceExhausted, errors.New(message))
	if detail, detailErr := connect.NewErrorDetail(&errdetails.RetryInfo{RetryDelay: durationpb.New(delay)}); detailErr == nil {
		err.AddDetail(detail)
	}
	return err
}

// waitForQuerySlot waits for a slot. When the waiter queue is full it refuses at
// once, naming fullHint() as its retry delay.
func waitForQuerySlot(ctx context.Context, active, waiting chan struct{}, fullHint func() time.Duration) error {
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
		return resourceExhaustedWithRetry("observability query queue is full; retry shortly", fullHint())
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
	// Count both active and provider-queued requests in the same global
	// admission cap. Otherwise arbitrary provider names could accumulate
	// unbounded waiters before reaching the global execution semaphore.
	select {
	case b.admitted <- struct{}{}:
	default:
		return nil, nil, resourceExhaustedWithRetry("observability gateway admission queue is full; retry shortly",
			retryDelay(&b.hold, len(b.admitted)-cap(b.active), cap(b.active)))
	}
	sample := &holdSample{}
	ctx = context.WithValue(ctx, holdSampleKey{}, sample)
	queueCtx, stop := context.WithTimeout(ctx, b.queueTimeout)
	defer stop()
	slots := b.providerSlots(provider)
	providerAcquired, globalAcquired := false, false
	var acquired time.Time
	release := func() {
		if globalAcquired {
			if sample.resolved.Load() {
				b.observeHold(provider, b.clock().Sub(acquired))
			}
			<-b.active
		}
		if providerAcquired {
			<-slots.active
		}
		b.releaseProvider(provider, slots)
		<-b.admitted
	}
	providerHint := func() time.Duration {
		return retryDelay(holdEstimatorFor(b.holdLookup(provider), &b.hold), len(slots.waiting), cap(slots.active))
	}
	globalHint := func() time.Duration { return retryDelay(&b.hold, len(b.waiting), cap(b.active)) }
	if err := waitForQuerySlot(queueCtx, slots.active, slots.waiting, providerHint); err != nil {
		release()
		return nil, nil, queueWaitError(ctx, queueCtx, err, providerHint())
	}
	providerAcquired = true
	if err := waitForQuerySlot(queueCtx, b.active, b.waiting, globalHint); err != nil {
		release()
		return nil, nil, queueWaitError(ctx, queueCtx, err, globalHint())
	}
	globalAcquired, acquired = true, b.clock()
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

// queueWaitError classifies a slot wait that failed. When only the queue's own
// timer ended the wait, the caller still has budget, so the answer is a
// resource_exhausted with a retry hint: a busy provider, not a spent request. A
// caller deadline or cancellation keeps the code contextError gave it.
func queueWaitError(caller, queue context.Context, err error, delay time.Duration) error {
	if caller.Err() != nil || !errors.Is(queue.Err(), context.DeadlineExceeded) {
		return err
	}
	return resourceExhaustedWithRetry("observability query waited too long for a free slot; retry shortly", delay)
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
