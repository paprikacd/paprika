package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-logr/logr"
)

func TestCloudRunConsoleConfigurationDoesNotAdvertiseUnsupportedLogin(t *testing.T) {
	t.Parallel()
	mux := buildCloudRunMux(http.NotFoundHandler(), http.NotFoundHandler(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "static UI fallback", http.StatusTeapot)
	}), logr.Discard())
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/config", http.NoBody))
	if response.Code != http.StatusOK {
		t.Fatalf("GET /auth/config status = %d, want 200", response.Code)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("login configuration must not be cached")
	}
	var config struct {
		OIDC struct {
			Enabled bool `json:"enabled"`
		} `json:"oidc"`
		Basic struct {
			Enabled bool `json:"enabled"`
		} `json:"basic"`
		Session struct {
			RefreshEnabled bool `json:"refreshEnabled"`
		} `json:"session"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil {
		t.Fatalf("login configuration was not JSON: %v", err)
	}
	if config.OIDC.Enabled || config.Basic.Enabled || config.Session.RefreshEnabled {
		t.Fatal("legacy Cloud Run entrypoint must not advertise console login or refresh")
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/auth/config", http.NoBody))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /auth/config status = %d, want 405", response.Code)
	}
}

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
