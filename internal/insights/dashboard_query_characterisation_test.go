package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"
)

// The base golden was captured from the output before the attention and breach
// fields existed, for a document with no warning or critical status thresholds.
// Additive fields may appear in the new output; every other value must match.
func TestDashboardQueryCharacterisesBaseOutputWithoutStatusThresholds(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("query") {
		case "requests":
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1792972800,"1.5"],[1792972812,"2.5"],[1792972824,"NaN"]]}]}}`)
		case "two":
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1792972800,"1"],[1792972812,"3"]]},{"metric":{"service":"worker"},"values":[[1792972800,"2"],[1792972812,"4"]]}]}}`)
		case "boom":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = fmt.Fprint(w, `{"status":"error","error":"boom"}`)
		default:
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		}
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	rate := queryReadWidget("rate", "requests")
	rate["options"] = map[string]any{"decimals": 2, "staleAfterSeconds": 3600, "thresholds": []any{map[string]any{"value": 2, "color": "#123456", "label": "High"}}}
	trend := queryReadWidget("trend", "two")
	trend["type"], trend["options"] = "timeseries", map[string]any{"decimals": 1}
	missing := queryReadWidget("missing", "requests")
	missing["queryRef"] = map[string]any{"id": "missing-query"}
	putReadDashboard(t, s, rate, trend, queryReadWidget("boom", "boom"), queryReadWidget("empty", "empty"), missing)

	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	observed := regexp.MustCompile(`"observedAt":"[^"]*"`)
	actual := observed.ReplaceAll(w.Body.Bytes(), []byte(`"observedAt":"OBSERVED"`))
	golden, err := os.ReadFile("testdata/dashboard_query_base.json")
	require.NoError(t, err)
	require.JSONEq(t, string(golden), string(stripAdditiveDashboardFields(t, actual)))
}

// stripAdditiveDashboardFields removes the fields this contract adds for documents
// without status thresholds: the top-level attention summary and omitted list, per-widget
// attention, breaches, bandSeries and sample, and freshness objects that carry no
// staleAfterSeconds threshold.
func stripAdditiveDashboardFields(t *testing.T, raw []byte) []byte {
	t.Helper()
	var document map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	delete(document, "attention")
	delete(document, "omitted")
	widgets, _ := document["widgets"].([]any)
	for _, entry := range widgets {
		widget, ok := entry.(map[string]any)
		require.True(t, ok)
		delete(widget, "attention")
		delete(widget, "breaches")
		delete(widget, "sample")
		delete(widget, "bandSeries")
		if freshness, ok := widget["freshness"].(map[string]any); ok {
			if _, thresholded := freshness["thresholdSeconds"]; !thresholded {
				delete(widget, "freshness")
			}
		}
	}
	stripped, err := json.Marshal(document)
	require.NoError(t, err)
	return stripped
}
