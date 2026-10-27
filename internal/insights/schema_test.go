package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

func TestAuthoringSchemaReadOnlyCanonicalContract(t *testing.T) {
	var providerCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { providerCalls.Add(1) }))
	t.Cleanup(provider.Close)
	s, store := testService(t, ProviderConfig{ID: "metrics-provider-id", Name: "Metrics", Type: "prometheus", URL: provider.URL})
	before, err := os.ReadDir(store.dir)
	require.NoError(t, err)
	for _, kind := range []string{"dashboard", "widget", "saved_query"} {
		t.Run(kind, func(t *testing.T) {
			w := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			require.Equal(t, "application/json", w.Header().Get("Content-Type"))
			require.LessOrEqual(t, w.Body.Len(), maxSchemaResponseBytes)
			var response authoringSchemaResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
			require.Equal(t, 1, response.SchemaVersion)
			require.Equal(t, kind, response.Kind)
			expected, schemaErr := insightsschema.Document(kind)
			require.NoError(t, schemaErr)
			require.JSONEq(t, string(expected), string(response.Schema))
			require.Len(t, response.Examples, 1)
			require.NotEmpty(t, response.Notes)
			switch kind {
			case "dashboard":
				require.NoError(t, validateDashboard("service-overview", response.Examples[0]))
			case "widget":
				require.NoError(t, validateDashboardWidgetShape(response.Examples[0]))
			case "saved_query":
				_, validationErr := validateSavedQuery("service-request-rate", response.Examples[0])
				require.NoError(t, validationErr)
			}
		})
	}
	after, err := os.ReadDir(store.dir)
	require.NoError(t, err)
	require.Equal(t, before, after, "schema reads must not create persisted documents")
	require.Empty(t, store.List())
	require.Empty(t, s.savedQueries.list(""))
	require.Zero(t, providerCalls.Load(), "schema reads must not execute provider queries")
}

func TestAuthoringSchemaExamplesCanBeSavedTogether(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "metrics-provider-id", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:1"})
	for _, example := range []struct{ path, body string }{
		{"/api/saved-queries/service-request-rate", schemaSavedQueryExample},
		{"/api/dashboards/service-overview", schemaDashboardExample},
	} {
		w := request(t, s.Handler(), http.MethodPut, example.path, []byte(example.body), map[string]string{"If-None-Match": "*"})
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		require.NotEmpty(t, w.Header().Get("ETag"))
	}
}

func TestAuthoringSchemaRequiresAuthenticationAndKnownKind(t *testing.T) {
	s, _ := testService(t)
	for _, tc := range []struct {
		method, path, token string
		status              int
	}{
		{http.MethodGet, "/api/schemas/dashboard", "", http.StatusUnauthorized},
		{http.MethodGet, "/api/schemas/dashboard", "Bearer invalid", http.StatusUnauthorized},
		{http.MethodGet, "/api/schemas/provider", "Bearer " + testToken, http.StatusBadRequest},
		{http.MethodPost, "/api/schemas/dashboard", "Bearer " + testToken, http.StatusMethodNotAllowed},
	} {
		w := request(t, s.Handler(), tc.method, tc.path, nil, map[string]string{"Authorization": tc.token})
		require.Equal(t, tc.status, w.Code, w.Body.String())
	}
}
