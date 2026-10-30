package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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
			require.NotEmpty(t, response.Examples)
			require.NotEmpty(t, response.Notes)
			switch kind {
			case "dashboard":
				require.NoError(t, validateDashboard("service-overview", response.Examples[0]))
			case "widget":
				for _, example := range response.Examples {
					require.NoError(t, validateDashboardWidgetShape(example), string(example))
				}
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

func TestRecordAuthoringSchemaExamples(t *testing.T) {
	require.NoError(t, validateDashboardWidgetShape(json.RawMessage(schemaRecordWidgetExample)))
	query, err := validateSavedQuery("service-records", json.RawMessage(schemaRecordQueryExample))
	require.NoError(t, err)
	require.NoError(t, validateSQLTemplate("postgresql", query.Query))
	ranged, err := validateSavedQuery("service-history", json.RawMessage(schemaRangeRecordQueryExample))
	require.NoError(t, err)
	require.NoError(t, validateSQLTemplate("postgresql", ranged.Query))
	require.Contains(t, ranged.Query, `{"range":"start"}`)
	require.Contains(t, ranged.Query, `{"range":"end"}`)
	require.Len(t, authoringSchemaExamples("widget"), 8)
	require.Len(t, authoringSchemaExamples("saved_query"), 3)
}

func TestAuthoringSchemaDiscoversRichChartContracts(t *testing.T) {
	s, _ := testService(t)
	for _, kind := range []string{"dashboard", "widget"} {
		t.Run(kind, func(t *testing.T) {
			w := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var response authoringSchemaResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
			notes := strings.Join(response.Notes, "\n")
			for _, plugin := range []string{"stacked-timeseries", "directional-traffic", "distribution-heatmap", "threshold-gauge", "connection-map", "geo-heatmap", "pipeline-topology", "incident-calendar", "status-grid", "uptime-calendar", "uptime-timeline", "small-multiples"} {
				require.Contains(t, notes, plugin, "MCP authors must discover each installed rich plugin without inspecting UI code")
			}
			for _, contract := range []string{"legendDisplay?:compact|table", "legendPosition?:bottom|right", "seriesMode?:first|all", "columns?:1..12", "orientation?:horizontal|vertical", "maxSeries?:1..12", "maxColumns?:8..120", "density?:compact|comfortable", "showSearch?:boolean", "arithmetic mean", "query-side rates", "nonnegative", "numeric degrees", "Cycles remain explicit", "Days without observations stay unknown"} {
				require.Contains(t, notes, contract)
			}
			require.Contains(t, notes, "cellStyles?:[{column:string,display:bar|bar-segments|color-text|color-background")
			require.Contains(t, notes, "sparkline string contains an ordered JSON array")
			require.Contains(t, notes, "filtering never rescales bars")
			require.Contains(t, notes, "options.seriesColors", "AI authors must discover how to style a time-series by exact metric labels")
			for _, contract := range []string{"display=status-badge", "barColorMode=gradient|value", "unmapped and missing values remain neutral", "colorField?:string,colorMin?:number,colorMax?:number", "not underlying scrape or ingestion health", "options.staleAfterSeconds", "showStatus?:boolean", "showStatus defaults to false", "missing observation is Unknown"} {
				require.Contains(t, notes, contract)
			}
			require.Contains(t, notes, "colorMode?:intensity|thresholds", "Incident calendar coloring must be discoverable")
			require.Contains(t, notes, "sparkline cellStyle may set thresholdColumn", "Row-based sparkline coloring must be discoverable")
			require.Contains(t, notes, "config.showRowNumbers", "Displayed row numbering must be discoverable")
			require.Contains(t, notes, "colorScale?:linear|logarithmic", "Heatmap authors must discover logarithmic density coloring")
			require.Contains(t, notes, "keeping zero separate", "Logarithmic heatmap coloring must explain observed zero")
			require.Contains(t, notes, `{"range":"start"}`, "SQL authors must discover request-range parameters")
			require.Contains(t, notes, "does not automatically filter SQL", "Do not imply that SQL follows dashboard time automatically")
			require.Contains(t, notes, "options.thresholds color the aggregated daily value", "Describe the threshold input, not individual records")
			require.Contains(t, string(response.Schema), `"seriesColors"`)
			require.LessOrEqual(t, w.Body.Len(), maxSchemaResponseBytes)
		})
	}
}

func TestRecordChartAuthoringExamplesCanBeSavedTogether(t *testing.T) {
	s, _ := testService(t)
	body, err := json.Marshal(map[string]any{
		"schemaVersion": 1, "id": "record-chart-overview", "title": "Record chart overview",
		"timeRange": "1h", "refreshInterval": 0,
		"widgets": []json.RawMessage{json.RawMessage(schemaStyledTableExample), json.RawMessage(schemaGroupedTreemapExample)},
	})
	require.NoError(t, err)
	require.NoError(t, validateDashboard("record-chart-overview", body))
	w := request(t, s.Handler(), http.MethodPut, "/api/dashboards/record-chart-overview", body, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	etag := w.Header().Get("ETag")
	require.NotEmpty(t, etag)
	loaded := request(t, s.Handler(), http.MethodGet, "/api/dashboards/record-chart-overview", nil, nil)
	require.Equal(t, http.StatusOK, loaded.Code, loaded.Body.String())
	require.JSONEq(t, string(body), loaded.Body.String())
	stale := request(t, s.Handler(), http.MethodPut, "/api/dashboards/record-chart-overview", body, map[string]string{"If-Match": `"stale"`})
	require.Equal(t, http.StatusPreconditionFailed, stale.Code, stale.Body.String())
	require.Equal(t, etag, loaded.Header().Get("ETag"))
}

func TestRichMetricAuthoringExamplesCanBeSavedTogether(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "metrics-provider-id", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:1"})
	body, err := json.Marshal(map[string]any{
		"schemaVersion": 1, "id": "rich-chart-overview", "title": "Rich chart overview",
		"timeRange": "1h", "refreshInterval": 0,
		"widgets": []json.RawMessage{json.RawMessage(schemaStackedWidgetExample), json.RawMessage(schemaGaugeBankExample), json.RawMessage(schemaDistributionExample)},
	})
	require.NoError(t, err)
	require.NoError(t, validateDashboard("rich-chart-overview", body))
	w := request(t, s.Handler(), http.MethodPut, "/api/dashboards/rich-chart-overview", body, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotEmpty(t, w.Header().Get("ETag"))
	loaded := request(t, s.Handler(), http.MethodGet, "/api/dashboards/rich-chart-overview", nil, nil)
	require.Equal(t, http.StatusOK, loaded.Code, loaded.Body.String())
	require.JSONEq(t, string(body), loaded.Body.String(), "rich widget configuration must survive document persistence")
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
