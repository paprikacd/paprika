package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLocalFixtureCredentialLifetime(t *testing.T) {
	t.Parallel()
	for _, ttl := range []time.Duration{time.Hour, 12 * time.Hour, 24 * time.Hour} {
		token, err := mintFixtureToken([]byte("isolated-test-secret"), "reader", "console", []string{"metrics-readers"}, ttl)
		if err != nil {
			t.Fatal(err)
		}
		payload, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
		if err != nil {
			t.Fatal(err)
		}
		var claims struct {
			IssuedAt  int64  `json:"iat"`
			ExpiresAt int64  `json:"exp"`
			Audience  string `json:"aud"`
			Scope     string `json:"scope"`
		}
		if err := json.Unmarshal(payload, &claims); err != nil {
			t.Fatal(err)
		}
		if got := time.Duration(claims.ExpiresAt-claims.IssuedAt) * time.Second; got != ttl {
			t.Fatalf("lifetime = %v, want %v", got, ttl)
		}
		if claims.Audience != "console" || claims.Scope != "paprika:observe" {
			t.Fatalf("unexpected claims: %+v", claims)
		}
	}
	for _, ttl := range []time.Duration{0, -time.Second, 24*time.Hour + time.Second} {
		if _, err := mintFixtureToken([]byte("isolated-test-secret"), "reader", "console", nil, ttl); err == nil {
			t.Fatalf("accepted invalid lifetime %v", ttl)
		}
	}
}

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
