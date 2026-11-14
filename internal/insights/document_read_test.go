package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// fillDocumentBytes takes the whole body budget, so the next body byte must wait.
func fillDocumentBytes(t *testing.T, s *Server) {
	_, ok := s.documentBytes.reserve(s.documentBytes.capacity)
	require.True(t, ok, "the budget starts empty")
}

// With the body budget full, a save and a dry run both wait the wait timeout and then
// get the same 429 and retry hint as the other Insights admission errors.
func TestDocumentReadsAreRefusedAfterTheWaitWhenBudgetIsFull(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 20 * time.Millisecond
	h := s.Handler()
	fillDocumentBytes(t, s)
	document := dashboard("demo", "Clean")
	for name, call := range map[string]func() *httptest.ResponseRecorder{
		"save": func() *httptest.ResponseRecorder { return request(t, h, "PUT", "/api/dashboards/demo", document, nil) },
		"dry run": func() *httptest.ResponseRecorder {
			return request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
		},
	} {
		w := call()
		require.Equal(t, http.StatusTooManyRequests, w.Code, "%s: %s", name, w.Body)
		require.Equal(t, "1", w.Header().Get("Retry-After"), name)
		require.Contains(t, w.Body.String(), "too many active dashboard uploads; retry shortly", name)
	}
	require.Zero(t, len(s.checkSlots), "a refused upload never reaches a check slot")
	require.Equal(t, s.documentBytes.capacity, s.documentBytes.inUse(), "a refused upload took no bytes")
}

// A request that finds the budget full, but bytes free within the wait timeout, goes
// through rather than being refused.
func TestDocumentReadWaitsForFreeBytes(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 5 * time.Second
	h := s.Handler()
	fillDocumentBytes(t, s)
	go func() {
		time.Sleep(50 * time.Millisecond)
		s.documentBytes.release(s.documentBytes.capacity)
	}()
	w := request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Clean")), nil)
	require.Equal(t, http.StatusOK, w.Code, "a request that waited for bytes: %s", w.Body)
}

// The waiting queue is bounded. Once it is full, a request is refused at once
// rather than waiting out the timeout.
func TestDocumentReadWaitingQueueIsBounded(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 10 * time.Second
	h := s.Handler()
	fillDocumentBytes(t, s)
	for range cap(s.documentWaiting) {
		s.documentWaiting <- struct{}{}
	}
	started := time.Now()
	w := request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Clean")), nil)
	require.Equal(t, http.StatusTooManyRequests, w.Code, "%s", w.Body)
	require.Less(t, time.Since(started), 5*time.Second, "a request beyond the queue waited instead of failing fast")
	for range cap(s.documentWaiting) {
		<-s.documentWaiting
	}
}

// A canceled upload that is waiting for bytes gives up its queue place, and it
// reserves nothing on its behalf.
func TestCanceledDocumentReadReleasesItsPlace(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 10 * time.Second
	fillDocumentBytes(t, s)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- s.reserveBodyBytes(ctx, 1)
	}()
	require.Eventually(t, func() bool { return len(s.documentWaiting) == 1 }, 5*time.Second, time.Millisecond)
	cancel()
	select {
	case err := <-result:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("a canceled waiter did not return")
	}
	require.Zero(t, len(s.documentWaiting), "a canceled waiter left its queue place behind")
	require.Equal(t, s.documentBytes.capacity, s.documentBytes.inUse(), "the canceled waiter reserved bytes")
}

// Each refusal of the body budget is counted by route, so an operator can see the
// window in which every save and dry run is refused.
func TestBodyBudgetRefusalsAreCounted(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 10 * time.Millisecond
	h := s.Handler()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	counter, err := provider.Meter("test").Int64Counter("paprika_insights_dashboard_upload_refusals")
	require.NoError(t, err)
	s.uploadRefusals = counter
	fillDocumentBytes(t, s)
	document := dashboard("demo", "Clean")

	require.Equal(t, http.StatusTooManyRequests, request(t, h, "PUT", "/api/dashboards/demo", document, nil).Code)
	require.Equal(t, http.StatusTooManyRequests, request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil).Code)
	require.Equal(t, http.StatusTooManyRequests, request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil).Code)

	var collected metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &collected))
	counts := map[string]int64{}
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			require.True(t, ok, "the refusal counter is an int64 sum")
			for _, point := range sum.DataPoints {
				route, _ := point.Attributes.Value(attribute.Key("route"))
				counts[route.AsString()] += point.Value
			}
		}
	}
	require.Equal(t, map[string]int64{uploadRouteSave: 1, uploadRouteDryRun: 2}, counts)
}

// The production refusal counter has the name the README and the dashboards use. The
// other tests swap in their own counter, so this one reads the instrument NewServer
// creates through the constructor it calls.
func TestUploadRefusalCounterHasItsDocumentedName(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	counter, err := newUploadRefusalCounter(provider.Meter("test"))
	require.NoError(t, err)
	counter.Add(t.Context(), 1, metric.WithAttributes(attribute.String("route", uploadRouteSave)))

	var collected metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &collected))
	var names []string
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			names = append(names, m.Name)
		}
	}
	require.Equal(t, []string{"paprika_insights_dashboard_upload_refusals"}, names)
}
