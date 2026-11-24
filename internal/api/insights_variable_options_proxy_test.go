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

const variableOptionsProxyPath = "/api/insights/dashboards/overview/variable-options"

// variableOptionsProxyStatus sends one request through an Insights proxy whose upstream records its calls.
func variableOptionsProxyStatus(t *testing.T, upstreamURL, method, path string, projectOnly bool) int {
	t.Helper()
	cfg := insightsAuthConfig("read")
	if projectOnly {
		cfg.RBACRules[0].Projects = []string{"team-a"}
	}
	proxy, err := NewInsightsProxy(t.Context(), cfg, upstreamURL, "service-token-with-at-least-32-characters")
	require.NoError(t, err)
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: "reader", Secret: cfg.TokenSecret, Audience: auth.ConsoleAPIAudience})
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, req)
	return response.Code
}

func TestInsightsVariableOptionsPOSTTakesReadPermission(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "/api/dashboards/overview/variable-options", r.URL.Path)
		_, _ = io.WriteString(w, `{"variables":[]}`)
	}))
	defer upstream.Close()
	require.Equal(t, http.StatusOK, variableOptionsProxyStatus(t, upstream.URL, http.MethodPost, variableOptionsProxyPath, false))
	require.Equal(t, http.StatusForbidden, variableOptionsProxyStatus(t, upstream.URL, http.MethodPut, variableOptionsProxyPath, false))
	require.Equal(t, http.StatusForbidden, variableOptionsProxyStatus(t, upstream.URL, http.MethodPost, variableOptionsProxyPath+"-write", false))
	require.Equal(t, http.StatusForbidden, variableOptionsProxyStatus(t, upstream.URL, http.MethodPost, variableOptionsProxyPath, true))
	require.Equal(t, 1, calls, "only the exact authorized read route may reach Insights")
}
