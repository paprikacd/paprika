package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fillDocumentReads takes every document-read slot, so the next upload must wait.
func fillDocumentReads(s *Server) {
	for range cap(s.documentReads) {
		s.documentReads <- struct{}{}
	}
}

// emptyDocumentReads releases whatever read slots are still held. A test may have
// freed one itself, so it drains without blocking.
func emptyDocumentReads(s *Server) {
	for {
		select {
		case <-s.documentReads:
		default:
			return
		}
	}
}

// With every read slot taken, a save and a dry run both wait the wait timeout and
// then get the same 429 and retry hint as the other Insights admission errors.
func TestDocumentReadsAreRefusedAfterTheWaitWhenPoolIsFull(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 20 * time.Millisecond
	h := s.Handler()
	fillDocumentReads(s)
	defer emptyDocumentReads(s)
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
}

// A request that finds the pool full, but a slot frees within the wait timeout, goes
// through rather than being refused.
func TestDocumentReadWaitsForAFreeSlot(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 5 * time.Second
	h := s.Handler()
	fillDocumentReads(s)
	go func() {
		time.Sleep(50 * time.Millisecond)
		<-s.documentReads
	}()
	defer emptyDocumentReads(s)
	w := request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Clean")), nil)
	require.Equal(t, http.StatusOK, w.Code, "a request that waited for a slot: %s", w.Body)
}

// The waiting queue is bounded. Once it is full, a request is refused at once
// rather than waiting out the timeout.
func TestDocumentReadWaitingQueueIsBounded(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 10 * time.Second
	h := s.Handler()
	fillDocumentReads(s)
	defer emptyDocumentReads(s)
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

// A canceled upload that is waiting for a read slot gives up its queue place, and
// nothing reads or is refused on its behalf.
func TestCanceledDocumentReadReleasesItsPlace(t *testing.T) {
	s, _ := testService(t)
	s.documentWaitTimeout = 10 * time.Second
	fillDocumentReads(s)
	defer emptyDocumentReads(s)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := s.acquireDocumentRead(ctx)
		result <- err
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
	require.Equal(t, cap(s.documentReads), len(s.documentReads), "the canceled waiter took a read slot")
}
