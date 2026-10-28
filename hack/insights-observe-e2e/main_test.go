package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAppHandlerReportsNoInteractiveLogin(t *testing.T) {
	t.Parallel()
	handler, err := newAppHandler(http.NotFoundHandler(), &telemetryFixture{}, "", t.TempDir())
	if err != nil {
		t.Fatalf("create fixture handler: %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/config", http.NoBody))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET /auth/config status/cache = %d/%q", response.Code, response.Header().Get("Cache-Control"))
	}
	var config map[string]map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil {
		t.Fatalf("decode auth configuration: %v", err)
	}
	if config["oidc"]["enabled"] != false || config["basic"]["enabled"] != false || config["session"]["refreshEnabled"] != false {
		t.Fatalf("bearer-token fixture advertised interactive login: %v", config)
	}
}
