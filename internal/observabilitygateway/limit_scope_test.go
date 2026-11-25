package observabilitygateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// refusedScope begins one request on the budget and returns the scope of its refusal.
func refusedScope(t *testing.T, b *executionBudget, provider string) LimitScope {
	t.Helper()
	_, release, err := b.begin(context.Background(), provider)
	require.Error(t, err)
	require.Nil(t, release)
	scope, ok := LimitScopeOf(err)
	require.True(t, ok, "refusal %v names no scope", err)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	return scope
}

func TestLimitScopeQueueWhenAdmissionQueueIsFull(t *testing.T) {
	t.Parallel()
	// One slot and no queue: the first request fills the admission queue.
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 0, ProviderQueue: 0, QueueWait: time.Second}, time.Second)
	_, release, err := b.begin(context.Background(), "obs/prom")
	require.NoError(t, err)
	defer release()
	assert.Equal(t, ScopeQueue, refusedScope(t, b, "obs/other"))
}

func TestLimitScopeProviderWhenProviderBulkheadIsFull(t *testing.T) {
	t.Parallel()
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 4, ProviderConcurrency: 1, Queue: 4, ProviderQueue: 0, QueueWait: time.Second}, time.Second)
	_, release, err := b.begin(context.Background(), "obs/prom")
	require.NoError(t, err)
	defer release()
	// Another provider still starts: its refusal would not name provider scope.
	_, otherRelease, err := b.begin(context.Background(), "obs/other")
	require.NoError(t, err)
	otherRelease()
	assert.Equal(t, ScopeProvider, refusedScope(t, b, "obs/prom"))
}

func TestLimitScopeBudgetWhenGlobalSlotWaitExpires(t *testing.T) {
	t.Parallel()
	// One global slot and one waiter. A second provider waits for the slot and times out.
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 1, ProviderQueue: 4, QueueWait: 20 * time.Millisecond}, time.Second)
	_, release, err := b.begin(context.Background(), "obs/prom")
	require.NoError(t, err)
	defer release()
	assert.Equal(t, ScopeBudget, refusedScope(t, b, "obs/other"))
}

func TestLimitScopeUnnamedRefusalIsNotScoped(t *testing.T) {
	t.Parallel()
	_, ok := LimitScopeOf(connect.NewError(connect.CodeResourceExhausted, errors.New("screenshot too large")))
	assert.False(t, ok)
}

func TestWriteDashboardErrorSetsLimitScopeHeader(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"edge", withLimitScope(ScopeEdge, resourceExhaustedWithRetry("x", time.Second)), "edge"},
		{"budget", withLimitScope(ScopeBudget, resourceExhaustedWithRetry("x", time.Second)), "budget"},
		{"provider", withLimitScope(ScopeProvider, resourceExhaustedWithRetry("x", time.Second)), "provider"},
		{"queue", withLimitScope(ScopeQueue, resourceExhaustedWithRetry("x", time.Second)), "queue"},
		{"unnamed", resourceExhaustedWithRetry("x", time.Second), "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeDashboardError(recorder, tc.err)
			require.Equal(t, http.StatusTooManyRequests, recorder.Code)
			assert.Equal(t, tc.want, recorder.Header().Get(LimitScopeHeader))
			assert.NotEmpty(t, recorder.Header().Get("Retry-After"))
		})
	}
}
