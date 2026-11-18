package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A pool's refusal names the wait its observed hold time implies. With no
// samples it is the one-second floor.
func TestObservabilityPoolRefusalRetryAfterFollowsHoldTime(t *testing.T) {
	pool := newObservabilityAdmissionPool(1, 0)
	require.Equal(t, 1, pool.retryAfter(), "no samples gives the floor")

	pool.hold.Observe(4 * time.Second)
	require.Equal(t, 4, pool.retryAfter(), "one slot with no waiters ahead takes one average")

	recorder := httptest.NewRecorder()
	rejectObservabilityAdmission(recorder, pool.retryAfter())
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.Equal(t, "4", recorder.Header().Get("Retry-After"))
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
}

// Refusals from a saturated pool are answered with the estimate, not a constant.
func TestObservabilityEdgeRefusesWithItsPoolEstimate(t *testing.T) {
	edge := newObservabilityEdge(observabilityHTTPPools{Work: 1, WorkWaiters: 0, Catalog: 1, Dashboards: 1, Intake: 4, AdmissionWait: time.Second})
	edge.work.hold.Observe(3 * time.Second)
	require.True(t, edge.work.acquire(t.Context()), "the first request takes the only work slot")
	defer edge.work.release()

	handler := edge.middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, observabilityGatewayRoutePrefix+"/api/query", http.NoBody)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.Equal(t, "3", recorder.Header().Get("Retry-After"))
}

// The edge measures how long each admitted request holds its pool slot, so a
// later refusal names that time. The hold here goes through the middleware itself,
// not a seeded estimator. A 1.5 s request rounds up to a 2 s hint.
func TestObservabilityEdgeMeasuresHoldTimeThroughMiddleware(t *testing.T) {
	edge := newObservabilityEdge(observabilityHTTPPools{Work: 1, WorkWaiters: 0, Catalog: 1, Dashboards: 1, Intake: 4, AdmissionWait: time.Second})
	slow := edge.middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { time.Sleep(1500 * time.Millisecond) }))
	request := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		slow.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodPost, observabilityGatewayRoutePrefix+"/api/query", http.NoBody))
		return recorder
	}
	require.Equal(t, http.StatusOK, request().Code, "the slow request is admitted and answered")
	require.Positive(t, edge.work.hold.Average(), "the middleware recorded the admitted request's hold")

	require.True(t, edge.work.acquire(t.Context()), "a second request holds the only work slot")
	defer edge.work.release()
	recorder := request()
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.Equal(t, "2", recorder.Header().Get("Retry-After"), "a 1.5 s average hold rounds up to 2 s, not the 1 s floor")
}
