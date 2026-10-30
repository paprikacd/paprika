package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/stretchr/testify/require"
)

func TestAnnotationSourceAcceptsTimeBasedVisualizations(t *testing.T) {
	for _, tc := range []struct {
		name, widgetType, pluginID string
		valid                      bool
	}{
		{"timeseries", "timeseries", "", true},
		{"stacked", "plugin", "stacked-timeseries", true},
		{"directional", "plugin", "directional-traffic", true},
		{"bar", "bar", "", false},
		{"record-table", "plugin", "record-table", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			widget := map[string]json.RawMessage{
				"type":             json.RawMessage(fmt.Sprintf("%q", tc.widgetType)),
				"annotationSource": json.RawMessage(`{"queryRef":{"id":"events"},"timestampColumn":"date","labelColumn":"label"}`),
			}
			if tc.widgetType == "plugin" {
				widget["pluginId"] = json.RawMessage(fmt.Sprintf("%q", tc.pluginID))
				widget["dataKind"] = json.RawMessage(`"metrics"`)
			}
			err := validateWidgetExtensions(widget)
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, "time-series or directional-traffic")
			}
		})
	}
}

func TestDashboardBundlesAnnotationQueryAndProtectsItsRevision(t *testing.T) {
	const metrics = "team/metrics"
	const records = "team/warehouse"
	var eventCalls int
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			providers := []observeCatalogProvider{{Name: metrics, Namespace: "team", Type: "prometheus"}}
			if r.Header.Get("Authorization") == "Bearer allowed" {
				providers = append(providers, observeCatalogProvider{Name: records, Namespace: "team", Type: "postgresql"})
			}
			writeJSON(w, 200, map[string]any{"providers": providers})
		case "/query_metrics":
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1792972800,"2"]]}]}}`)})
		case "/query_records":
			eventCalls++
			var input struct {
				Query string `json:"query"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			require.Contains(t, input.Query, `"checkout"`)
			writeJSON(w, 200, map[string]any{"state": "OK", "data": &dataframe.Frame{Columns: []dataframe.Column{{Key: "date", Type: "string"}, {Key: "end", Type: "timestamp"}, {Key: "label", Type: "string"}}, Rows: [][]any{{"2026-10-26T00:30:00Z", "2026-10-26T00:45:00Z", "Deploy"}}}})
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	events := SavedQuery{SchemaVersion: 1, ID: "events", Name: "Events", ProviderID: observeProviderID(records), Kind: "records", Query: `{"sql":"SELECT event_time, label FROM incidents WHERE service=$1","parameters":[{{service}}]}`, Parameters: []SavedQueryParameter{{Name: "service", Type: "string"}}}
	headers := observeHeaders("allowed")
	headers["If-None-Match"] = "*"
	w := request(t, s.Handler(), http.MethodPut, "/api/saved-queries/events", savedQueryJSON(t, events), headers)
	require.Equal(t, 200, w.Code, w.Body.String())
	etag := w.Header().Get("ETag")
	widget := queryReadWidget("chart", "up")
	widget["providerId"], widget["type"], widget["dataKind"], widget["pluginId"] = observeProviderID(metrics), "plugin", "metrics", "stacked-timeseries"
	widget["annotationSource"] = map[string]any{"queryRef": map[string]any{"id": "events", "bindings": []any{map[string]any{"parameter": "service", "source": "variable", "variable": "service"}}}, "timestampColumn": "date", "endColumn": "end", "labelColumn": "label"}
	dashboardRaw, dashboardETag := putReadDashboard(t, s, widget)
	body := []byte(`{"id":"overview",` + dashboardQueryWindow + `}`)
	result := readDashboardResult(t, request(t, s.Handler(), http.MethodPost, "/api/query-dashboard", body, observeHeaders("allowed")))
	require.Equal(t, "ok", result.State)
	require.Equal(t, dashboardETag, result.Dashboard.ETag)
	require.Equal(t, etag, result.SavedQueries[0].ETag)
	require.Equal(t, "q1", result.Widgets[0].SignalID)
	require.Equal(t, "q2", result.Widgets[0].AnnotationSignalID)
	require.Equal(t, "events", result.Widgets[0].AnnotationSavedQueryID)
	require.Equal(t, "metrics", result.Signals[0].Kind)
	require.Equal(t, observeProviderID(metrics), result.Signals[0].ProviderID)
	require.Equal(t, "records", result.Signals[1].Kind)
	require.Equal(t, observeProviderID(records), result.Signals[1].ProviderID)
	require.Equal(t, "date", result.Widgets[0].AnnotationColumns.Timestamp)
	require.Equal(t, "end", result.Widgets[0].AnnotationColumns.End)
	require.Equal(t, "label", result.Widgets[0].AnnotationColumns.Label)
	require.Equal(t, 1, result.Signals[1].Records.Returned)
	require.Equal(t, 1, eventCalls)
	var edited map[string]any
	require.NoError(t, json.Unmarshal(dashboardRaw, &edited))
	editedWidget := edited["widgets"].([]any)[0].(map[string]any)
	editedWidget["annotationSource"].(map[string]any)["labelColumn"] = "missing_column"
	changed := mustMarshalAnnotationResult(t, edited)
	_, err := s.store.Put("overview", changed, dashboardETag, "")
	require.NoError(t, err)
	missing := readDashboardResult(t, request(t, s.Handler(), http.MethodPost, "/api/query-dashboard", body, observeHeaders("allowed")))
	require.Equal(t, "partial", missing.State)
	require.Equal(t, "ok", missing.Signals[0].State, "primary metric stays available")
	require.NotNil(t, missing.Widgets[0].AnnotationError)
	require.Equal(t, "invalid_annotation_columns", missing.Widgets[0].AnnotationError.Code)
	require.Equal(t, 2, eventCalls)
	require.True(t, s.store.usesSavedQuery("events"))
	headers = observeHeaders("allowed")
	headers["If-Match"] = etag
	deleteResponse := request(t, s.Handler(), http.MethodDelete, "/api/saved-queries/events", nil, headers)
	require.Equal(t, http.StatusConflict, deleteResponse.Code)
	denied := readDashboardResult(t, request(t, s.Handler(), http.MethodPost, "/api/query-dashboard", body, observeHeaders("denied")))
	require.Equal(t, "partial", denied.State)
	require.Equal(t, "q1", denied.Widgets[0].SignalID)
	require.Equal(t, "ok", denied.Signals[0].State)
	require.NotNil(t, denied.Signals[1].Error)
	require.Equal(t, "records", denied.Signals[1].Kind)
	require.Empty(t, denied.Signals[1].ProviderID, "A provider inaccessible to the caller must not be disclosed through a saved annotation")
	require.Equal(t, "events", denied.Widgets[0].AnnotationSavedQueryID, "The dashboard's authored reference remains identifiable")
	require.NotNil(t, denied.Widgets[0].AnnotationError)
	require.False(t, strings.Contains(string(mustMarshalAnnotationResult(t, denied)), "Bearer"))
	require.Equal(t, 2, eventCalls)
}

func mustMarshalAnnotationResult(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	require.NoError(t, err)
	return data
}

func TestAnnotationColumnValidationHonorsCompactLimit(t *testing.T) {
	columns := []dataframe.Column{{Key: "date", Type: "timestamp"}, {Key: "label", Type: "string"}}
	for i := 2; i < 13; i++ {
		columns = append(columns, dataframe.Column{Key: fmt.Sprintf("extra%d", i), Type: "string"})
	}
	require.Nil(t, validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", Label: "label"}))
	require.Nil(t, validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", End: "date", Label: "label"}))
	require.Equal(t, "invalid_annotation_columns", validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", End: "missing", Label: "label"}).Code)
	require.Equal(t, "invalid_annotation_columns", validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", Label: "missing"}).Code)
	require.Equal(t, "annotation_columns_truncated", validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", Label: "extra12"}).Code)
	columns[0].Type = "boolean"
	require.Equal(t, "invalid_annotation_columns", validateAnnotationColumns(columns, &dashboardReadAnnotationColumns{Timestamp: "date", Label: "label"}).Code)
}
