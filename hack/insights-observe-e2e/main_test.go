package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func TestLabEntryTicketIsSingleUseAndExpires(t *testing.T) {
	t.Parallel()
	clock := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	lab := newLabEntry(func() time.Time { return clock }, time.Minute)
	ticket, err := lab.issue("bearer-for-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, wrongErr := lab.redeem(ticket + "x"); wrongErr == nil {
		t.Fatal("redeemed a wrong ticket")
	}
	bearer, err := lab.redeem(ticket)
	if err != nil || bearer != "bearer-for-test" {
		t.Fatalf("first redemption = %q, %v", bearer, err)
	}
	if _, reuseErr := lab.redeem(ticket); reuseErr == nil {
		t.Fatal("redeemed a used ticket twice")
	}

	ticket, err = lab.issue("bearer-for-test")
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Minute)
	if _, err := lab.redeem(ticket); err == nil {
		t.Fatal("redeemed a ticket at its expiry instant")
	}
}

func TestLabEntryPageRequiresLoopbackAndSafeDestination(t *testing.T) {
	t.Parallel()
	lab := newLabEntry(time.Now, time.Minute)
	ticket, err := lab.issue("bearer-for-test")
	if err != nil {
		t.Fatal(err)
	}
	handler := lab.wrap(http.NotFoundHandler())
	serve := func(remote, host, target string) *httptest.ResponseRecorder {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, target, http.NoBody)
		request.RemoteAddr = remote
		request.Host = host
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if got := serve("203.0.113.7:4000", "127.0.0.1:8080", "/__lab/enter?ticket="+ticket).Code; got != http.StatusForbidden {
		t.Fatalf("remote enter status = %d, want 403", got)
	}
	if got := serve("127.0.0.1:4000", "rebind.example:8080", "/__lab/enter?ticket="+ticket).Code; got != http.StatusForbidden {
		t.Fatalf("rebound host status = %d, want 403", got)
	}
	for _, next := range []string{"//evil.example/", "https://evil.example/", "/api/insights/providers", "/dashboard/insights/\r\nSet-Cookie: x"} {
		if got := serve("127.0.0.1:4000", "127.0.0.1:8080", "/__lab/enter?ticket="+ticket+"&next="+url.QueryEscape(next)).Code; got != http.StatusBadRequest {
			t.Fatalf("destination %q status = %d, want 400", next, got)
		}
	}
	response := serve("[::1]:4000", "localhost:8080", "/__lab/enter?ticket="+ticket+"&next="+url.QueryEscape("/dashboard/insights/?dashboard=local-polish-service"))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("loopback enter status/headers = %d/%v", response.Code, response.Header())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"bearer-for-test"`) || !strings.Contains(body, `"/dashboard/insights/?dashboard=local-polish-service"`) {
		t.Fatalf("enter page does not set the session and destination: %s", body)
	}
	if got := serve("127.0.0.1:4000", "127.0.0.1:8080", "/__lab/enter?ticket="+ticket).Code; got != http.StatusNotFound {
		t.Fatalf("reused enter status = %d, want 404", got)
	}
}

func TestLabEntryHeadDoesNotConsumeTicket(t *testing.T) {
	t.Parallel()
	lab := newLabEntry(time.Now, time.Minute)
	ticket, err := lab.issue("bearer-for-test")
	if err != nil {
		t.Fatal(err)
	}
	handler := lab.wrap(http.NotFoundHandler())
	target := "/__lab/enter?ticket=" + ticket
	loopback := func(method string) *http.Request {
		request := httptest.NewRequestWithContext(t.Context(), method, target, http.NoBody)
		request.RemoteAddr, request.Host = "127.0.0.1:4000", "127.0.0.1:8080"
		return request
	}
	head := httptest.NewRecorder()
	handler.ServeHTTP(head, loopback(http.MethodHead))
	if head.Code != http.StatusMethodNotAllowed {
		t.Fatalf("HEAD status = %d, want 405", head.Code)
	}
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, loopback(http.MethodGet))
	if get.Code != http.StatusOK {
		t.Fatalf("GET after HEAD status = %d, want 200 (HEAD must not spend the ticket)", get.Code)
	}
}

func TestQueryFixtureRangeConversion(t *testing.T) {
	t.Parallel()
	var received map[string]any
	resolver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/query" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode fixture request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"series":[{"name":"p50","labels":{"quantile":"p50"},"points":[{"timestamp":60000,"value":22},{"timestamp":120000,"value":null},{"timestamp":180000,"value":24.5}]}]}`))
	}))
	defer resolver.Close()
	fixture, err := newTelemetryFixture(resolver.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/query_range?query=fixture_percentiles&start=0&end=200&step=60", http.NoBody)
	request.Header.Set("Authorization", "Bearer fixture-provider-secret")
	response := httptest.NewRecorder()
	fixture.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("range status = %d body %s", response.Code, response.Body.String())
	}
	var matrix struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Values [][]any           `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &matrix); err != nil {
		t.Fatal(err)
	}
	if len(matrix.Data.Result) != 1 || matrix.Data.Result[0].Metric["quantile"] != "p50" || len(matrix.Data.Result[0].Values) != 3 {
		t.Fatalf("matrix = %s", response.Body.String())
	}
	if matrix.Data.Result[0].Values[0][0] != 60.0 || matrix.Data.Result[0].Values[0][1] != "22" {
		t.Fatalf("first sample = %v", matrix.Data.Result[0].Values[0])
	}
	if gap := matrix.Data.Result[0].Values[1]; gap[0] != 120.0 || gap[1] != "NaN" {
		t.Fatalf("null observation must be NaN at its timestamp, got %v", gap)
	}
	if received["query"] != "fixture_percentiles" || received["kind"] != "metrics" {
		t.Fatalf("resolver received %v", received)
	}
}

func TestQueryFixtureFailuresAndTargets(t *testing.T) {
	t.Parallel()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://fixtures.example:9000/query", http.StatusFound)
	}))
	defer redirect.Close()
	fixture, err := newTelemetryFixture(redirect.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/query_range?query=fixture_requests", http.NoBody)
	request.Header.Set("Authorization", "Bearer fixture-provider-secret")
	response := httptest.NewRecorder()
	fixture.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("redirected fixture status = %d, want 502", response.Code)
	}
	if _, err := newTelemetryFixture("http://fixtures.example:9000"); err == nil {
		t.Fatal("accepted a non-loopback query fixture")
	}
	unauthenticated := httptest.NewRecorder()
	fixture.ServeHTTP(unauthenticated, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/query_range?query=fixture_requests", http.NoBody))
	if unauthenticated.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated provider status = %d, want 403", unauthenticated.Code)
	}
}
