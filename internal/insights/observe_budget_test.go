package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Each gateway call tells the gateway its remaining time: the operation's budget
// less a margin, so the gateway's deadline fires before Insights' own does.
func TestObserveRESTSendsTheOperationBudgetLessTheMargin(t *testing.T) {
	var got string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(ObserveBudgetHeader)
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	defer gateway.Close()
	g := mustObserveGateway(t, gateway.URL)
	var m queryMeasurement
	_, err := g.restDo(t.Context(), "alice", observeRESTProvidersPath, nil, 1<<20, &m)
	require.NoError(t, err)
	ms, err := strconv.ParseInt(got, 10, 64)
	require.NoError(t, err, "header %q", got)
	assert.LessOrEqual(t, ms, (ObserveOperationTimeout - observeBudgetMargin).Milliseconds())
	assert.Greater(t, ms, (ObserveOperationTimeout - observeBudgetMargin - 2*time.Second).Milliseconds())
}

// A caller budget under the one-second minimum is never sent: the gateway would
// ignore it, so the call fails here as a timeout, with no request on the wire.
func TestObserveRESTDoesNotDispatchBelowTheMinimumBudget(t *testing.T) {
	var hits atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	defer gateway.Close()
	g := mustObserveGateway(t, gateway.URL)
	ctx, cancel := context.WithTimeout(t.Context(), 1200*time.Millisecond)
	defer cancel()
	var m queryMeasurement
	_, err := g.restDo(ctx, "alice", observeRESTProvidersPath, nil, 1<<20, &m)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Zero(t, hits.Load(), "no request reaches the gateway")
	assert.False(t, m.dispatched.Load())
}

// A short bounded operation, such as the SLO save's 2 s provider lookup, still
// sends a useful budget: the margin is a quarter of what remains, not the full 2 s.
func TestObserveRequestBudgetKeepsShortOperationsDispatchable(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	budget, ok := observeRequestBudget(ctx)
	require.True(t, ok, "a 2 s operation is dispatched")
	assert.Greater(t, budget, 1400*time.Millisecond)
	assert.LessOrEqual(t, budget, 1500*time.Millisecond)
}
