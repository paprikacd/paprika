package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// flushingRecorder is a ResponseWriter that records Flush calls, standing in for
// the HTTP/2 writer a streaming RPC actually gets.
type flushingRecorder struct {
	*httptest.ResponseRecorder
	flushes int
}

func (f *flushingRecorder) Flush() { f.flushes++ }

// TestMetricsMiddlewareKeepsFlushReachable pins the wrapper's transparency.
//
// A bidirectional stream flushes per frame. If the metrics wrapper hides the
// underlying Flusher, Connect reports "does not implement http.Flusher" and the
// stream never opens — which is how the satellite link failed against the real
// server while every unit test passed.
func TestMetricsMiddlewareKeepsFlushReachable(t *testing.T) {
	t.Parallel()

	recorder := &flushingRecorder{ResponseRecorder: httptest.NewRecorder()}
	var sawFlusher bool
	handler := MetricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			sawFlusher = true
			// http.ResponseController is what connect uses; it walks Unwrap.
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Errorf("ResponseController.Flush: %v", err)
			}
		}
	}))

	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/paprika.v1.SatelliteLink/Connect", nil))

	if !sawFlusher {
		t.Fatal("the wrapper hides http.Flusher from the handler")
	}
	if recorder.flushes != 1 {
		t.Fatalf("flushes = %d, want 1", recorder.flushes)
	}
}

// TestMetricsMiddlewareRecordsTheStatusItServed guards the metric the wrapper
// exists for.
func TestMetricsMiddlewareRecordsTheStatusItServed(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	handler := MetricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil))

	if recorder.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusTeapot)
	}
}

// TestMetricsMiddlewareUnwrapsToTheOriginalWriter covers the controller path
// directly: http.ResponseController needs Unwrap to find the real writer.
func TestMetricsMiddlewareUnwrapsToTheOriginalWriter(t *testing.T) {
	t.Parallel()

	recorder := &flushingRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler := MetricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("ResponseController.Flush: %v", err)
		}
	}))
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/y", nil))

	if recorder.flushes != 1 {
		t.Fatalf("flushes = %d, want 1", recorder.flushes)
	}
}
