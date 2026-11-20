package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/insights/revisionsource"
)

const revisionProxyServiceToken = "service-token-with-at-least-32-characters"

// upstreamRecorder keeps the headers each proxied request carried to the Insights service.
type upstreamRecorder struct {
	mu      sync.Mutex
	headers []http.Header
}

func (u *upstreamRecorder) record(h http.Header) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.headers = append(u.headers, h.Clone())
}

func (u *upstreamRecorder) last(t *testing.T) http.Header {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.headers) == 0 {
		t.Fatal("the request never reached the Insights service")
	}
	return u.headers[len(u.headers)-1]
}

func (u *upstreamRecorder) calls() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.headers)
}

func newRevisionUpstream(t *testing.T) (*httptest.Server, *upstreamRecorder) {
	t.Helper()
	recorder := &upstreamRecorder{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.record(r.Header)
		if r.Header.Get("Authorization") != "Bearer "+revisionProxyServiceToken {
			t.Errorf("the service token is not forwarded: %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(upstream.Close)
	return upstream, recorder
}

func revisionAuthConfig() auth.Config {
	return auth.Config{Enabled: true, TokenSecret: []byte("browser-token-signing-secret"), RBACRules: []auth.RBACRule{
		{Subjects: []string{"writer"}, Actions: []string{"read", "write"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"reader"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
	}}
}

func revisionToken(t *testing.T, cfg auth.Config, subject string) string {
	t.Helper()
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: subject, Email: subject + "@example.test", Name: "Test " + subject, Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// A save carries the principal's subject and display name, and the source the proxy decided. Headers the browser sends
// for those fields are dropped, and the email address is never forwarded.
func TestInsightsProxyStampsRevisionAuthorAndSource(t *testing.T) {
	upstream, recorder := newRevisionUpstream(t)
	cfg := revisionAuthConfig()
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, revisionProxyServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/api/insights/dashboards/demo", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+revisionToken(t, cfg, "writer"))
	r.Header.Set("X-Paprika-Revision-Author-Subject", "someone-else")
	r.Header.Set("X-Paprika-Revision-Author-Name", "Someone Else")
	r.Header.Set("X-Paprika-Revision-Source", "mcp")
	r.Header.Set("X-Insights-Revision-Message", "Rename%20it")
	r.Header.Set("If-None-Match", "*")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("save returned %d: %s", w.Code, w.Body)
	}
	got := recorder.last(t)
	if got.Get("X-Paprika-Revision-Author-Subject") != "writer" {
		t.Errorf("author subject = %q, want the principal's subject", got.Get("X-Paprika-Revision-Author-Subject"))
	}
	if got.Get("X-Paprika-Revision-Author-Name") != "Test%20writer" {
		t.Errorf("author name = %q, want the principal's display name, percent-encoded", got.Get("X-Paprika-Revision-Author-Name"))
	}
	if got.Get("X-Paprika-Revision-Source") != "ui" {
		t.Errorf("source = %q, want ui because the browser cannot choose a source", got.Get("X-Paprika-Revision-Source"))
	}
	if got.Get("X-Insights-Revision-Message") != "Rename%20it" {
		t.Errorf("message = %q, want it forwarded unchanged", got.Get("X-Insights-Revision-Message"))
	}
	for name, values := range got {
		for _, value := range values {
			if strings.Contains(value, "@") {
				t.Errorf("header %s carries an email address", name)
			}
		}
	}
}

// Only an in-process caller that marks its context as MCP makes an MCP revision.
func TestInsightsProxyRecordsMCPSourceOnlyFromContext(t *testing.T) {
	upstream, recorder := newRevisionUpstream(t)
	cfg := revisionAuthConfig()
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, revisionProxyServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/api/insights/dashboards/demo", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+revisionToken(t, cfg, "writer"))
	r = r.WithContext(revisionsource.With(r.Context(), revisionsource.MCP))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("save returned %d: %s", w.Code, w.Body)
	}
	if got := recorder.last(t).Get("X-Paprika-Revision-Source"); got != "mcp" {
		t.Fatalf("source = %q, want mcp from the in-process caller", got)
	}
}

// Without authentication (local development) the proxy names no author and still forwards the source it decided.
func TestInsightsProxyWithoutPrincipalNamesNoAuthor(t *testing.T) {
	upstream, recorder := newRevisionUpstream(t)
	h, err := NewInsightsProxy(context.Background(), auth.Config{}, upstream.URL, revisionProxyServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/api/insights/dashboards/demo", strings.NewReader(`{}`))
	r.Header.Set("X-Paprika-Revision-Author-Subject", "someone-else")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("save returned %d: %s", w.Code, w.Body)
	}
	got := recorder.last(t)
	if got.Get("X-Paprika-Revision-Author-Subject") != "" || got.Get("X-Paprika-Revision-Author-Name") != "" {
		t.Errorf("an unauthenticated save named an author: %v", got)
	}
	if got.Get("X-Paprika-Revision-Source") != "ui" {
		t.Errorf("source = %q, want ui", got.Get("X-Paprika-Revision-Source"))
	}
}

// Revision reads take the read permission and restore takes write, as the other dashboard routes do. The mapping is
// checked directly and through the authorizer, so a read-only caller can list but not restore.
func TestInsightsRevisionRoutePermissions(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         auth.Action
	}{
		{http.MethodGet, "/api/insights/dashboards/demo/revisions", auth.ActionRead},
		{http.MethodGet, "/api/insights/dashboards/demo/revisions/3", auth.ActionRead},
		{http.MethodPost, "/api/insights/dashboards/demo/revisions/3/restore", auth.ActionWrite},
		{http.MethodPut, "/api/insights/dashboards/demo", auth.ActionWrite},
	} {
		r := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, nil)
		if got, _ := insightsRequestPermission(r); got != tc.want {
			t.Errorf("%s %s takes %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}

	upstream, recorder := newRevisionUpstream(t)
	cfg := revisionAuthConfig()
	h, err := NewInsightsProxy(context.Background(), cfg, upstream.URL, revisionProxyServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	reader := revisionToken(t, cfg, "reader")
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/insights/dashboards/demo/revisions", nil)
	r.Header.Set("Authorization", "Bearer "+reader)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("a reader listing revisions got %d: %s", w.Code, w.Body)
	}
	r = httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/insights/dashboards/demo/revisions/3/restore", nil)
	r.Header.Set("Authorization", "Bearer "+reader)
	r.Header.Set("If-Match", `"etag"`)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("a reader restoring a revision got %d, want 403: %s", w.Code, w.Body)
	}
	if calls := recorder.calls(); calls != 1 {
		t.Errorf("the refused restore reached the service: %d upstream calls, want 1", calls)
	}
}
