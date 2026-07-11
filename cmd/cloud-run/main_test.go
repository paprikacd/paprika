package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-logr/logr"
)

func TestCloudRunEventsRouteDisabled(t *testing.T) {
	t.Parallel()

	mux := buildCloudRunMux(
		http.NotFoundHandler(),
		http.NotFoundHandler(),
		http.NotFoundHandler(),
		logr.Discard(),
	)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/events?topic=dashboard", http.NoBody)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /events status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}
