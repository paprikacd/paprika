package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
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
