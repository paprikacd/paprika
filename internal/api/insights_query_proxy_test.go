package apiserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
)

func TestInsightsDashboardQueryPOSTIsReadOnlyAtExactRoute(t *testing.T) {
	const serviceToken = "service-token-with-at-least-32-characters"
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/api/query-dashboard", r.URL.Path)
		_, _ = io.WriteString(w, `{"signals":[]}`)
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		name, method, path string
		projectOnly        bool
		status             int
	}{
		{"dashboard read", http.MethodPost, "/api/insights/query-dashboard", false, http.StatusOK},
		{"nested path", http.MethodPost, "/api/insights/query-dashboard/dashboards", false, http.StatusForbidden},
		{"similar path", http.MethodPost, "/api/insights/query-dashboard-write", false, http.StatusForbidden},
		{"wrong method", http.MethodPut, "/api/insights/query-dashboard", false, http.StatusForbidden},
		{"dashboard write", http.MethodPost, "/api/insights/dashboards", false, http.StatusForbidden},
		{"project rule cannot grant global read", http.MethodPost, "/api/insights/query-dashboard", true, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := insightsAuthConfig("read")
			if tc.projectOnly {
				cfg.RBACRules[0].Projects = []string{"team-a"}
			}
			proxy, err := NewInsightsProxy(t.Context(), cfg, upstream.URL, serviceToken)
			require.NoError(t, err)
			token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
			require.NoError(t, err)
			req := httptest.NewRequestWithContext(t.Context(), tc.method, tc.path, strings.NewReader(`{"id":"demo"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			proxy.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code, response.Body.String())
		})
	}
	require.Equal(t, 1, calls, "only the exact authorized read route may reach Insights")
}
