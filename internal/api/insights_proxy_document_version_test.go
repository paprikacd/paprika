package apiserver

import (
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/insights"
)

const insightsDocumentVersionHeader = "X-Paprika-Document-ETag"

type insightsVersionProxy struct {
	handler       http.Handler
	upstreamCalls *atomic.Int64
	allowedToken  string
	deniedToken   string
}

func newInsightsVersionProxy(t *testing.T) insightsVersionProxy {
	t.Helper()
	serviceToken := rand.Text() + rand.Text()
	store, err := insights.OpenStore(t.TempDir())
	require.NoError(t, err)
	service, err := insights.NewServer(insights.Config{Token: serviceToken, Providers: []insights.ProviderConfig{
		{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"},
	}}, store)
	require.NoError(t, err)
	calls := &atomic.Int64{}
	serviceHandler := service.Handler()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		serviceHandler.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	cfg := insightsAuthConfig("read", "write")
	proxy, err := NewInsightsProxy(t.Context(), cfg, upstream.URL, serviceToken)
	require.NoError(t, err)
	allowed, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	require.NoError(t, err)
	denied, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "unauthorized-user", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	require.NoError(t, err)
	// Simulate a public compression proxy weakening only the representation's
	// HTTP validator after the application has produced its response.
	edge := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, r)
		for name, values := range rec.Header() {
			w.Header()[name] = append([]string{}, values...)
		}
		if tag := w.Header().Get("ETag"); r.Method == http.MethodGet && tag != "" {
			w.Header().Set("ETag", "W/"+tag)
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	})
	return insightsVersionProxy{handler: edge, upstreamCalls: calls, allowedToken: allowed, deniedToken: denied}
}

func (h insightsVersionProxy) request(t *testing.T, method, path, body, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), method, "/api/insights/"+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

func TestInsightsDocumentVersionSurvivesWeakPublicHTTPETags(t *testing.T) {
	for _, tc := range []struct {
		collection, original string
	}{
		{"dashboards", `{"schemaVersion":1,"id":"edge-version","title":"Original","timeRange":"1h","refreshInterval":0,"widgets":[]}`},
		{"saved-queries", `{"schemaVersion":1,"id":"edge-version","name":"Original","providerId":"metrics","kind":"metrics","query":"up"}`},
	} {
		t.Run(tc.collection, func(t *testing.T) {
			h := newInsightsVersionProxy(t)
			path := tc.collection + "/edge-version"
			created := h.request(t, http.MethodPut, path, tc.original, h.allowedToken, map[string]string{"If-None-Match": "*"})
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			version := created.Header().Get(insightsDocumentVersionHeader)
			require.Regexp(t, `^"[a-f0-9]{64}"$`, version)
			require.Equal(t, version, created.Header().Get("ETag"), "PUT must forward the canonical version")

			fetched := h.request(t, http.MethodGet, path, "", h.allowedToken, nil)
			require.Equal(t, http.StatusOK, fetched.Code)
			require.Equal(t, "W/"+version, fetched.Header().Get("ETag"))
			require.Equal(t, version, fetched.Header().Get(insightsDocumentVersionHeader))
			unchanged := h.request(t, http.MethodGet, path, "", h.allowedToken, map[string]string{"If-None-Match": fetched.Header().Get("ETag")})
			require.Equal(t, http.StatusNotModified, unchanged.Code)
			require.Equal(t, "W/"+version, unchanged.Header().Get("ETag"))
			require.Equal(t, version, unchanged.Header().Get(insightsDocumentVersionHeader), "304 must retain the exact document version")
			require.Empty(t, unchanged.Body.String())

			updatedDocument := strings.Replace(tc.original, "Original", "Updated", 1)
			weak := h.request(t, http.MethodPut, path, updatedDocument, h.allowedToken, map[string]string{"If-Match": fetched.Header().Get("ETag")})
			require.Equal(t, http.StatusPreconditionFailed, weak.Code, "a weak representation validator is not a document write version")
			preserved := h.request(t, http.MethodGet, path, "", h.allowedToken, nil)
			require.Equal(t, version, preserved.Header().Get(insightsDocumentVersionHeader))
			require.JSONEq(t, tc.original, preserved.Body.String())

			updated := h.request(t, http.MethodPut, path, updatedDocument, h.allowedToken, map[string]string{"If-Match": fetched.Header().Get(insightsDocumentVersionHeader)})
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			nextVersion := updated.Header().Get(insightsDocumentVersionHeader)
			require.Regexp(t, `^"[a-f0-9]{64}"$`, nextVersion)
			require.NotEqual(t, version, nextVersion)
			require.Equal(t, nextVersion, updated.Header().Get("ETag"))
			stale := h.request(t, http.MethodPut, path, tc.original, h.allowedToken, map[string]string{"If-Match": version})
			require.Equal(t, http.StatusPreconditionFailed, stale.Code)
			current := h.request(t, http.MethodGet, path, "", h.allowedToken, nil)
			require.Equal(t, nextVersion, current.Header().Get(insightsDocumentVersionHeader))
			require.JSONEq(t, updatedDocument, current.Body.String())

			calls := h.upstreamCalls.Load()
			for _, denied := range []struct {
				token  string
				status int
			}{{"", http.StatusUnauthorized}, {h.deniedToken, http.StatusForbidden}} {
				response := h.request(t, http.MethodGet, path, "", denied.token, map[string]string{"If-None-Match": "*"})
				require.Equal(t, denied.status, response.Code)
				require.Empty(t, response.Header().Get("ETag"))
				require.Empty(t, response.Header().Get(insightsDocumentVersionHeader), "authorization must precede document version disclosure")
			}
			require.Equal(t, calls, h.upstreamCalls.Load(), "denied conditional reads must not reach storage")
		})
	}
}
