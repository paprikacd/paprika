package observabilitygateway

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The default budget is the one the gateway shipped with: any change here is a
// capacity change and needs a matching docs and chart update.
func TestDefaultBudgetConfigMatchesBuiltIns(t *testing.T) {
	assert.Equal(t, BudgetConfig{
		Concurrency:         4,
		ProviderConcurrency: 2,
		Queue:               32,
		ProviderQueue:       8,
		QueueWait:           5 * time.Second,
	}, DefaultBudgetConfig())
	assert.Equal(t, 30*time.Second, RequestTimeout)
}

func TestNewExecutionBudgetFromDefaultConfigHasBuiltInCapacity(t *testing.T) {
	b := newExecutionBudgetFromConfig(DefaultBudgetConfig(), RequestTimeout)
	assert.Equal(t, 4, cap(b.active))
	assert.Equal(t, 32, cap(b.waiting))
	assert.Equal(t, 36, cap(b.admitted))
	assert.Equal(t, 2, b.perProvider)
	assert.Equal(t, 8, b.perProviderWaiting)
	assert.Equal(t, 5*time.Second, b.queueTimeout)
	assert.Equal(t, 30*time.Second, b.timeout)

	// The legacy constructor used by the existing budget tests builds the same budget.
	legacy := newExecutionBudget(4, RequestTimeout)
	assert.Equal(t, cap(b.active), cap(legacy.active))
	assert.Equal(t, cap(b.waiting), cap(legacy.waiting))
	assert.Equal(t, cap(b.admitted), cap(legacy.admitted))
	assert.Equal(t, b.perProvider, legacy.perProvider)
	assert.Equal(t, b.perProviderWaiting, legacy.perProviderWaiting)
	assert.Equal(t, b.queueTimeout, legacy.queueTimeout)
}

func TestExecutionBudgetFromConfigUsesEveryField(t *testing.T) {
	b := newExecutionBudgetFromConfig(BudgetConfig{
		Concurrency:         8,
		ProviderConcurrency: 3,
		Queue:               16,
		ProviderQueue:       5,
		QueueWait:           2 * time.Second,
	}, RequestTimeout)
	assert.Equal(t, 8, cap(b.active))
	assert.Equal(t, 16, cap(b.waiting))
	assert.Equal(t, 24, cap(b.admitted))
	assert.Equal(t, 3, b.perProvider)
	assert.Equal(t, 5, b.perProviderWaiting)
	assert.Equal(t, 2*time.Second, b.queueTimeout)
}

// A zero queue is a valid fail-fast budget: waiters are rejected at once.
func TestExecutionBudgetZeroQueueFailsFast(t *testing.T) {
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, QueueWait: time.Second}, RequestTimeout)
	assert.Equal(t, 0, cap(b.waiting))
	assert.Equal(t, 1, cap(b.admitted))
}

// The backend built with an explicit config sizes its budget from it; a zero
// config falls back to the defaults.
func TestBackendBudgetUsesConfiguredCapacity(t *testing.T) {
	configured := &k8sBackend{budgetConfig: BudgetConfig{Concurrency: 6, ProviderConcurrency: 3, Queue: 10, ProviderQueue: 2, QueueWait: 4 * time.Second}}
	b := configured.executionBudget()
	assert.Equal(t, 6, cap(b.active))
	assert.Equal(t, 3, b.perProvider)
	assert.Equal(t, 16, cap(b.admitted))
	assert.Equal(t, 4*time.Second, b.queueTimeout)

	defaulted := &k8sBackend{}
	d := defaulted.executionBudget()
	assert.Equal(t, 4, cap(d.active))
	assert.Equal(t, 2, d.perProvider)
	assert.Equal(t, 36, cap(d.admitted))
}

// A configured budget still enforces the per-provider bulkhead end to end.
func TestConfiguredBudgetEnforcesProviderBulkhead(t *testing.T) {
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 4, ProviderConcurrency: 1, Queue: 0, ProviderQueue: 0, QueueWait: time.Second}, RequestTimeout)
	_, release, err := b.begin(t.Context(), "ns/one")
	require.NoError(t, err)
	defer release()
	_, _, err = b.begin(t.Context(), "ns/one")
	require.Error(t, err, "second query on the same provider must not wait with zero provider queue")
	_, release2, err := b.begin(t.Context(), "ns/two")
	require.NoError(t, err, "a different provider is not blocked by the first")
	release2()
}

// A partial config must not produce a budget that rejects every query: zero
// Concurrency, ProviderConcurrency and QueueWait fall back to the defaults.
func TestPartialBudgetConfigFillsDefaults(t *testing.T) {
	b := newExecutionBudgetFromConfig(BudgetConfig{Concurrency: 8}, RequestTimeout)
	assert.Equal(t, 8, cap(b.active))
	assert.Equal(t, 2, b.perProvider)
	assert.Equal(t, 5*time.Second, b.queueTimeout)
	assert.Equal(t, 0, cap(b.waiting), "Queue is taken as given: zero means no waiters")

	empty := newExecutionBudgetFromConfig(BudgetConfig{}, RequestTimeout)
	assert.Equal(t, 4, cap(empty.active))
	assert.Equal(t, 2, empty.perProvider)
	assert.Equal(t, 5*time.Second, empty.queueTimeout)
}
