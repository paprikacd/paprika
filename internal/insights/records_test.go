package insights

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
)

func TestRecordSavedQueryDashboardMCPAndETags(t *testing.T) {
	const source = "team/warehouse"
	const sql = "SELECT service, uptime FROM summary WHERE service=$1"
	malicious := `api'); DELETE FROM services; -- {{service}}`
	calls := 0
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer caller", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: source, Namespace: "team", Type: "postgresql"}}})
		case "/query_records":
			calls++
			//nolint:tagliatelle // MCP wire contract uses snake_case.
			var input struct {
				Query string   `json:"query"`
				Limit int      `json:"limit"`
				Step  *float64 `json:"step_seconds"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			require.Equal(t, 1000, input.Limit)
			require.Nil(t, input.Step)
			var envelope struct {
				SQL        string   `json:"sql"`
				Parameters []string `json:"parameters"`
			}
			require.NoError(t, json.Unmarshal([]byte(input.Query), &envelope))
			require.Equal(t, sql, envelope.SQL)
			require.Equal(t, []string{malicious}, envelope.Parameters)
			writeJSON(w, 200, map[string]any{"state": "OK", "data": &dataframe.Frame{Columns: []dataframe.Column{{Key: "service", Type: "string"}, {Key: "uptime", Type: "number"}}, Rows: [][]any{{malicious, float64(0)}, {"unknown", nil}}, Truncated: true}})
		default:
			t.Errorf("unexpected tool %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	id := observeProviderID(source)
	doc := SavedQuery{SchemaVersion: 1, ID: "records", Name: "Service records", ProviderID: id, Kind: "records", Query: `{"sql":"` + sql + `","parameters":[{{service}}]}`, Parameters: []SavedQueryParameter{{Name: "service", Type: "string"}}}
	headers := observeHeaders("caller")
	headers["If-None-Match"] = "*"
	w := request(t, s.Handler(), "PUT", "/api/saved-queries/records", savedQueryJSON(t, doc), headers)
	require.Equal(t, 200, w.Code, w.Body.String())
	etag := w.Header().Get("ETag")
	widget := queryReadWidget("records", "unused")
	widget["providerId"], widget["type"], widget["dataKind"], widget["pluginId"] = id, "plugin", "records", "record-table"
	widget["queryRef"] = map[string]any{"id": "records", "bindings": []any{map[string]any{"parameter": "service", "source": "variable", "variable": "service"}}}
	_, dashboardETag := putReadDashboard(t, s, widget)
	input := `{"id":"overview","variables":{"service":` + dashboardStringLiteral(malicious) + `},` + dashboardQueryWindow + `}`
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(input), observeHeaders("caller")))
	require.Equal(t, "ok", result.State)
	require.Equal(t, 1, calls)
	require.Equal(t, dashboardETag, result.Dashboard.ETag)
	require.Equal(t, etag, result.SavedQueries[0].ETag)
	require.Equal(t, 2, result.Signals[0].Records.Returned)
	require.True(t, result.Signals[0].ProviderTruncated)
	require.Equal(t, float64(0), result.Signals[0].Records.Rows[0][1])
	require.Nil(t, result.Signals[0].Records.Rows[1][1])
	headers = observeHeaders("caller")
	headers["If-Match"] = `"stale"`
	w = request(t, s.Handler(), "PUT", "/api/saved-queries/records", savedQueryJSON(t, doc), headers)
	require.Equal(t, 412, w.Code, w.Body.String())
}

func TestRecordSummaryBoundsAndPartialHonesty(t *testing.T) {
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "text", Type: "string"}}, Rows: [][]any{{strings.Repeat("x", 300)}, {"two"}, {nil}, {"four"}}}
	result := summarizeDashboardResult(&QueryResult{Records: frame}, DashboardSummaryOptions{})
	require.Equal(t, "ok", result.State)
	require.True(t, result.Truncated)
	require.True(t, result.Records.RowsTruncated)
	require.True(t, result.Records.MetadataTruncated)
	require.False(t, result.ProviderTruncated)
	require.Equal(t, 4, result.Records.Returned)
	require.Len(t, result.Records.Rows, 3)
	frame.Rows = [][]any{}
	result = summarizeDashboardResult(&QueryResult{Records: frame}, DashboardSummaryOptions{})
	require.Equal(t, "empty", result.State)
	require.Zero(t, result.Records.Returned)
}

func TestDashboardRejectsSQLStructuralParametersBeforeProviderExecution(t *testing.T) {
	const source = "team/warehouse"
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/list_observability_providers" {
			t.Errorf("unsafe query reached provider execution: %s", r.URL.Path)
			writeError(w, http.StatusBadRequest, "unexpected query")
			return
		}
		writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: source, Namespace: "team", Type: "postgresql"}}})
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	widget := queryReadWidget("unsafe", `SELECT * FROM reporting.services WHERE service={{service}}`)
	widget["providerId"], widget["type"], widget["dataKind"], widget["pluginId"] = observeProviderID(source), "plugin", "records", "record-table"
	putReadDashboard(t, s, widget)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), observeHeaders("caller")))
	require.Equal(t, "partial", result.State)
	require.Zero(t, result.QueryCount.Executed)
	require.Empty(t, result.Signals)
	require.NotNil(t, result.Widgets[0].Error)
	require.Equal(t, "invalid_query", result.Widgets[0].Error.Code)
}
