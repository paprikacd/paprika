package apiserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/insights"
)

func insightsAuthConfig(actions ...string) auth.Config {
	return auth.Config{Enabled: true, TokenSecret: []byte("browser-token-signing-secret"), RBACRules: []auth.RBACRule{{Subjects: []string{"reader"}, Actions: actions, Resources: []string{"insights"}, Namespaces: []string{"*"}}}}
}

func TestInsightsProxyAuthenticationAuthorizationAndHeaders(t *testing.T) {
	const serviceToken = "service-token-with-at-least-32-characters"
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/query" || r.Header.Get("Authorization") != "Bearer "+serviceToken || r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Injected") != "" {
			t.Errorf("unexpected proxied request: %s headers=%v", r.URL.Path, r.Header)
		}
		_, _ = io.WriteString(w, `{"series":[]}`)
	}))
	defer upstream.Close()
	cfg := insightsAuthConfig("read")
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, serviceToken)
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path, token string
		status              int
	}{
		{"POST", "/api/insights/query", "", 401},
		{"PUT", "/api/insights/dashboards/demo", token, 403},
		{"POST", "/api/insights/query", token, 200},
	} {
		r := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer "+tc.token)
		r.Header.Set("Cookie", "private=user-cookie")
		r.Header.Set("X-Forwarded-For", "spoofed")
		r.Header.Set("X-Injected", "private-data")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s returned %d: %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
	if calls != 1 {
		t.Fatalf("unauthorized requests reached service: %d", calls)
	}
}

func TestInsightsProxyDashboardLifecycleAgainstRealService(t *testing.T) {
	const serviceToken = "service-token-with-at-least-32-characters"
	store, err := insights.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service, err := insights.NewServer(insights.Config{Token: serviceToken}, store)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(service.Handler())
	defer upstream.Close()
	cfg := insightsAuthConfig("write")
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, serviceToken)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(h)
	defer proxy.Close()
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	document := `{"schemaVersion":1,"id":"production","title":"Production","timeRange":"1h","refreshInterval":0,"widgets":[]}`
	var etag string
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"PUT", "/api/insights/dashboards/production", document, 200},
		{"GET", "/api/insights/dashboards/production", "", 200},
		{"GET", "/api/insights/dashboards", "", 200},
		{"DELETE", "/api/insights/dashboards/production", "", 204},
		{"GET", "/api/insights/dashboards/production", "", 404},
	} {
		req, err := http.NewRequestWithContext(context.Background(), tc.method, proxy.URL+tc.path, strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if tc.method == "DELETE" {
			req.Header.Set("If-Match", etag)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		if closeErr := resp.Body.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if resp.StatusCode != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, resp.StatusCode, body)
		}
		if tc.method == "PUT" {
			etag = resp.Header.Get("ETag")
			if etag == "" {
				t.Fatal("ETag lost in proxy")
			}
		}
	}
}

func TestInsightsProxyConfigurationAndUnavailableResponse(t *testing.T) {
	for _, endpoint := range []string{"file:///tmp/secret", "http://user:password@service", "https://service/?token=secret", "http://service/subpath"} {
		if _, err := NewInsightsProxy(context.Background(), auth.Config{}, endpoint, strings.Repeat("a", 32)); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", endpoint)
		}
	}
	h, err := NewInsightsProxy(context.Background(), auth.Config{}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), "GET", "/api/insights/providers", nil))
	var response map[string]string
	if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["error"] == "" {
		t.Fatalf("unconfigured service must return JSON 503: %d %s", w.Code, w.Body)
	}
}

func TestInsightsProxyRejectsProjectScopedWildcardGrant(t *testing.T) {
	cfg := insightsAuthConfig("read")
	cfg.RBACRules[0].Resources = []string{"*"}
	cfg.RBACRules[0].Projects = []string{"my-project"}
	h, err := NewInsightsProxy(context.Background(), cfg, "http://127.0.0.1:1", strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(context.Background(), "GET", "/api/insights/providers", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("project-scoped rule granted instance-wide access: %d %s", w.Code, w.Body)
	}
}

func TestInsightsProviderConfigurationRequiresAdmin(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	for _, tc := range []struct {
		permission, method, path string
		status                   int
	}{
		{"read", "GET", "/api/insights/provider-configs", 403},
		{"write", "GET", "/api/insights/provider-configs", 403},
		{"write", "PUT", "/api/insights/provider-configs/metrics", 403},
		{"write", "DELETE", "/api/insights/provider-configs/metrics", 403},
		{"admin", "GET", "/api/insights/provider-configs", 200},
		{"admin", "PUT", "/api/insights/provider-configs/metrics", 200},
		{"admin", "DELETE", "/api/insights/provider-configs/metrics", 200},
		{"read", "GET", "/api/insights/providers/metrics/metadata?kind=metrics", 200},
		{"read", "POST", "/api/insights/providers/metrics/test", 200},
	} {
		t.Run(tc.permission+" "+tc.method+" "+tc.path, func(t *testing.T) {
			cfg := insightsAuthConfig(tc.permission)
			h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, strings.Repeat("a", 32))
			if err != nil {
				t.Fatal(err)
			}
			token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, strings.NewReader(`{}`))
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.status, w.Body)
			}
		})
	}
}

func TestInsightsSavedQueryPermissionsAndConditionalHeaders(t *testing.T) {
	const expectedTag = `"saved-query-version"`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-Match") != expectedTag || r.Header.Get("If-None-Match") != "*" {
			t.Errorf("conditional headers lost: %v", r.Header)
		}
		if !strings.HasPrefix(r.URL.Path, "/api/saved-queries") || r.Header.Get("Cookie") != "" {
			t.Errorf("unsafe saved-query proxy request: %s %v", r.URL.Path, r.Header)
		}
		w.Header().Set("ETag", expectedTag)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		permission, method, path string
		status                   int
	}{
		{"read", "GET", "/api/insights/saved-queries?providerId=metrics", 200},
		{"read", "GET", "/api/insights/saved-queries/requests", 200},
		{"read", "PUT", "/api/insights/saved-queries/requests", 403},
		{"read", "DELETE", "/api/insights/saved-queries/requests", 403},
		{"write", "GET", "/api/insights/saved-queries/requests", 200},
		{"write", "PUT", "/api/insights/saved-queries/requests", 200},
		{"write", "DELETE", "/api/insights/saved-queries/requests", 200},
		{"admin", "PUT", "/api/insights/saved-queries/requests", 200},
	} {
		t.Run(tc.permission+" "+tc.method+" "+tc.path, func(t *testing.T) {
			cfg := insightsAuthConfig(tc.permission)
			h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, strings.Repeat("a", 32))
			if err != nil {
				t.Fatal(err)
			}
			token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, strings.NewReader(`{}`))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Cookie", "private=browser-session")
			r.Header.Set("If-Match", expectedTag)
			r.Header.Set("If-None-Match", "*")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.status, w.Body)
			}
			if tc.status == 200 && w.Header().Get("ETag") != expectedTag {
				t.Fatal("ETag response header lost")
			}
		})
	}
}

func TestInsightsSavedQueryLifecycleThroughRealService(t *testing.T) {
	const serviceToken = "service-token-with-at-least-32-characters"
	store, err := insights.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service, err := insights.NewServer(insights.Config{Token: serviceToken, Providers: []insights.ProviderConfig{{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://unused-provider:9090"}}}, store)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(service.Handler())
	defer upstream.Close()
	cfg := insightsAuthConfig("write")
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, serviceToken)
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Name: "Reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	document := `{"schemaVersion":1,"id":"requests","name":"Requests","providerId":"metrics","kind":"metrics","query":"up{service={{service}}}","parameters":[{"name":"service","type":"string"}]}`
	tag := ""
	for _, tc := range []struct {
		method, path, match, noneMatch string
		status                         int
	}{
		{"PUT", "/api/insights/saved-queries/requests", "", "*", 200},
		{"GET", "/api/insights/saved-queries?providerId=metrics", "", "", 200},
		{"GET", "/api/insights/saved-queries/requests", "", "", 200},
		{"GET", "/api/insights/saved-queries/requests", "", "current", 304},
		{"PUT", "/api/insights/saved-queries/requests", `"stale"`, "", 412},
		{"DELETE", "/api/insights/saved-queries/requests", "", "", 428},
		{"DELETE", "/api/insights/saved-queries/requests", "current", "", 204},
		{"GET", "/api/insights/saved-queries/requests", "", "", 404},
	} {
		r := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, strings.NewReader(document))
		r.Header.Set("Authorization", "Bearer "+token)
		for name, value := range map[string]string{"If-Match": tc.match, "If-None-Match": tc.noneMatch} {
			if value == "current" {
				value = tag
			}
			if value != "" {
				r.Header.Set(name, value)
			}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
		if tc.method == "PUT" && tc.status == 200 {
			tag = w.Header().Get("ETag")
			if tag == "" {
				t.Fatal("saved query ETag lost")
			}
		}
	}
}

func TestInsightsProxyDelegatesHumanIdentityWithoutForwardingBrowserSecrets(t *testing.T) {
	const serviceToken = "service-token-with-at-least-32-characters"
	const issuer = "https://paprika.example.test"
	cfg := insightsAuthConfig("read")
	verifier, err := auth.NewSelfSignedAuthenticatorForAudience(cfg.TokenSecret, "paprika-observability", issuer)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		delegated := r.Header.Get("X-Paprika-Observe-Token")
		if delegated == "" || delegated == "browser-injected" {
			t.Error("missing trusted delegation")
		}
		verification := httptest.NewRequestWithContext(r.Context(), "GET", "/observe/api/providers", nil)
		verification.Header.Set("Authorization", "Bearer "+delegated)
		principal, verifyErr := verifier.Authenticate(auth.WithRequest(r.Context(), verification))
		if verifyErr != nil {
			t.Fatal(verifyErr)
		}
		if principal.Subject != "reader" || principal.Email != "reader@example.test" || !slices.Equal(principal.Groups, []string{"metrics-readers"}) || !slices.Equal(principal.Scopes, []string{"paprika:observe"}) {
			t.Errorf("identity changed: %#v", principal)
		}
		if r.Header.Get("Authorization") != "Bearer "+serviceToken || r.Header.Get("Cookie") != "" {
			t.Error("browser secret leaked")
		}
		_, _ = io.WriteString(w, `{"providers":[]}`)
	}))
	defer upstream.Close()
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, serviceToken, InsightsProxyOptions{ObservabilityIssuer: issuer})
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Email: "reader@example.test", Groups: []string{"metrics-readers"}, Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(context.Background(), "GET", "/api/insights/providers", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Paprika-Observe-Token", "browser-injected")
	r.Header.Set("Cookie", "session=private")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("request failed: %d %s", w.Code, w.Body)
	}
	if _, err := NewInsightsProxy(context.Background(), auth.Config{}, upstream.URL, serviceToken, InsightsProxyOptions{ObservabilityIssuer: issuer}); err == nil {
		t.Fatal("unauthenticated delegation accepted")
	}
}
