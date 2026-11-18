package observabilitygateway

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/genproto/googleapis/rpc/errdetails"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// retryInfoDelay returns the RetryInfo delay a refusal carries, or false when it
// has none.
func retryInfoDelay(t *testing.T, err error) (time.Duration, bool) {
	t.Helper()
	var ce *connect.Error
	require.ErrorAs(t, err, &ce)
	for _, detail := range ce.Details() {
		value, valueErr := detail.Value()
		require.NoError(t, valueErr)
		if info, ok := value.(*errdetails.RetryInfo); ok {
			return info.GetRetryDelay().AsDuration(), true
		}
	}
	return 0, false
}

// Every refusal for capacity names a retry delay. A full admission queue and a
// full per-provider queue both carry RetryInfo, not only a queue-wait expiry.
func TestBudgetFullQueueRefusalsCarryRetryInfo(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 0, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
	_, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	defer release()

	_, _, err = budget.begin(t.Context(), "uptime")
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	delay, ok := retryInfoDelay(t, err)
	require.True(t, ok, "an admission refusal names its retry delay")
	require.Equal(t, time.Second, delay, "with no hold-time samples the delay is the one-second floor")
}

// The hint follows the hold times the budget has observed.
func TestBudgetRefusalHintFollowsObservedHoldTime(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 0, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
	budget.hold.Observe(4 * time.Second)
	_, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	defer release()

	_, _, err = budget.begin(t.Context(), "uptime")
	delay, ok := retryInfoDelay(t, err)
	require.True(t, ok)
	require.Equal(t, 4*time.Second, delay, "one slot, one ahead, and a 4 s average hold")
}

// A queue-wait expiry takes the same computed hint, and the cap holds it at 10 s.
func TestBudgetQueueWaitExpiryHintIsComputedAndCapped(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 4, QueueWait: 20 * time.Millisecond}, time.Minute)
	budget.hold.Observe(time.Hour)
	_, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	defer release()

	_, _, err = budget.begin(t.Context(), "uptime")
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	delay, ok := retryInfoDelay(t, err)
	require.True(t, ok)
	require.Equal(t, 10*time.Second, delay, "a long average is capped at the browser's replay cap")
}

// A canceled caller keeps its own error, with no retry hint.
func TestBudgetCallerCancelHasNoRetryHint(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 4, QueueWait: time.Minute}, time.Minute)
	_, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	defer release()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, _, err = budget.begin(ctx, "uptime")
	require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
	_, ok := retryInfoDelay(t, err)
	require.False(t, ok)
}

// fakeBudgetClock makes a slot's hold time whatever the test advances the clock
// by, so the hold estimators can be driven without sleeping.
type fakeBudgetClock struct{ now time.Time }

func (c *fakeBudgetClock) read() time.Time { return c.now }

// Catalog listings are fast reads that take a global slot. Their hold times must
// not move the estimate that sizes query refusals, or a busy catalog pulls every
// query hint down to the floor.
func TestBudgetCatalogHoldsDoNotSizeQueryRefusals(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
	clock := &fakeBudgetClock{now: time.Unix(1_000, 0)}
	budget.clock = clock.read

	ctx, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	markProviderResolved(ctx)
	clock.now = clock.now.Add(4 * time.Second)
	release()
	before := budget.hold.Average()
	require.InDelta(t, 4, before, 1e-9)

	for range 30 {
		_, done, err := budget.begin(t.Context(), catalogBudgetProvider)
		require.NoError(t, err)
		clock.now = clock.now.Add(time.Millisecond)
		done()
	}
	require.InDelta(t, before, budget.hold.Average(), 1e-9, "catalog holds stay out of the budget-wide estimate")
}

// A provider that goes idle keeps its own hold estimate, so its next refusal is
// still sized from its own slow queries rather than the budget-wide average.
func TestBudgetProviderHintSurvivesIdleProvider(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
	clock := &fakeBudgetClock{now: time.Unix(1_000, 0)}
	budget.clock = clock.read

	ctx, release, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	markProviderResolved(ctx)
	clock.now = clock.now.Add(4 * time.Second)
	release()

	// Fast traffic on other providers drags the budget-wide average to the floor.
	for range 30 {
		otherCtx, done, otherErr := budget.begin(t.Context(), "other")
		require.NoError(t, otherErr)
		markProviderResolved(otherCtx)
		clock.now = clock.now.Add(time.Millisecond)
		done()
	}

	ctx, holder, err := budget.begin(t.Context(), "uptime")
	require.NoError(t, err)
	markProviderResolved(ctx)
	defer holder()
	_, _, err = budget.begin(t.Context(), "uptime")
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	delay, ok := retryInfoDelay(t, err)
	require.True(t, ok)
	require.Equal(t, 4*time.Second, delay, "the provider's own 4 s hold sizes its refusal, not the budget-wide average dragged down by other providers")
}

// A slot held for a name that never resolves feeds no hold estimate, and the
// refusal for it adds no per-provider estimator, so made-up provider names cannot
// fill the estimator table or drag the budget-wide hint down.
func TestBudgetUnresolvedProviderHoldsRecordNothing(t *testing.T) {
	budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
	clock := &fakeBudgetClock{now: time.Unix(1_000, 0)}
	budget.clock = clock.read

	_, release, err := budget.begin(t.Context(), "ns/missing")
	require.NoError(t, err)
	clock.now = clock.now.Add(4 * time.Second)
	release()
	require.Zero(t, budget.hold.Average(), "a failed resolution is not a sample of the budget")
	require.Empty(t, budget.holds, "a failed resolution creates no per-provider estimator")

	// A provider-queue refusal for an unknown name is answered from the budget-wide
	// estimate, and creates no estimator for that name.
	_, holder, err := budget.begin(t.Context(), "ns/unknown")
	require.NoError(t, err)
	defer holder()
	_, _, err = budget.begin(t.Context(), "ns/unknown")
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	require.Empty(t, budget.holds, "a refusal for an unknown name creates no estimator")
}

// steppingClock moves step forward on every read, so each slot's hold time is
// exactly step, whatever the query does in between.
type steppingClock struct {
	now  time.Time
	step time.Duration
}

func (c *steppingClock) read() time.Time {
	c.now = c.now.Add(c.step)
	return c.now
}

// A slot feeds the hold estimates only when its provider resolved. Query and
// Explore both mark resolution on the backend path, so a resolvable provider
// records its hold through each operation, and a missing one records nothing.
func TestBackendHoldSamplesRequireResolvedProvider(t *testing.T) {
	newBudget := func() *executionBudget {
		budget := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 0, QueueWait: time.Second}, time.Minute)
		budget.clock = (&steppingClock{now: time.Unix(1_000, 0), step: 2 * time.Second}).read
		return budget
	}
	for _, operation := range []string{"query", "explore"} {
		t.Run(operation, func(t *testing.T) {
			call := func(b *k8sBackend, provider string) error {
				if operation == "query" {
					_, err := b.Query(t.Context(), provider, connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
					return err
				}
				_, err := b.Explore(t.Context(), provider, connector.ExploreRequest{Kind: connector.ExploreMetricNames})
				return err
			}

			resolvedBudget := newBudget()
			require.NoError(t, call(budgetBackend(t, resolvedBudget, func(context.Context) error { return nil }), "obs/prom"))
			require.InDelta(t, 2, resolvedBudget.hold.Average(), 1e-9, "a resolved provider's slot hold is a budget-wide sample")
			own := resolvedBudget.holdLookup("obs/prom")
			require.NotNil(t, own, "a resolved provider gets its own hold estimate")
			require.InDelta(t, 2, own.Average(), 1e-9)

			missingBudget := newBudget()
			require.Error(t, call(budgetBackend(t, missingBudget, func(context.Context) error { return nil }), "obs/missing"))
			require.Zero(t, missingBudget.hold.Average(), "a provider that does not resolve feeds no budget-wide sample")
			require.Empty(t, missingBudget.holds, "a provider that does not resolve creates no estimator")
		})
	}
}
