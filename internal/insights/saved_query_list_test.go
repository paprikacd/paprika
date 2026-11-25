package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func putSavedQueryForList(t *testing.T, h http.Handler, id string, document map[string]any) {
	t.Helper()
	w := request(t, h, "PUT", "/api/saved-queries/"+id, savedQueryJSON(t, document), map[string]string{"If-None-Match": "*"})
	require.Equal(t, 200, w.Code, w.Body.String())
}

func savedQueryListIDs(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, 200, w.Code, w.Body.String())
	var result struct {
		Queries []struct {
			ID string `json:"id"`
		} `json:"queries"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	ids := make([]string, 0, len(result.Queries))
	for _, query := range result.Queries {
		ids = append(ids, query.ID)
	}
	return ids
}

func savedQueryListFixture(t *testing.T) http.Handler {
	t.Helper()
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	s, _ := testService(t, provider)
	h := s.Handler()
	requests := savedQueryDocument("requests")
	requests["tags"] = []string{"edge"}
	requests["metadata"] = map[string]string{"team": "payments"}
	putSavedQueryForList(t, h, "requests", requests)
	latency := map[string]any{"schemaVersion": 1, "id": "latency", "name": "Latency p95", "providerId": "metrics", "kind": "metrics", "query": "histogram_quantile(0.95, sum(rate(http_duration_bucket[5m])))", "tags": []string{"api"}}
	putSavedQueryForList(t, h, "latency", latency)
	return h
}

func TestSavedQueryListFiltersByQ(t *testing.T) {
	h := savedQueryListFixture(t)
	for _, tc := range []struct {
		name string
		path string
		want []string
	}{
		{"id and name, case-insensitive", "/api/saved-queries?q=REQUESTS", []string{"requests"}},
		{"terms must all match", "/api/saved-queries?q=requests+edge", []string{"requests"}},
		{"terms that match different queries combine to nothing", "/api/saved-queries?q=latency+edge", []string{}},
		{"tag", "/api/saved-queries?q=api", []string{"latency"}},
		{"metadata value", "/api/saved-queries?q=payments", []string{"requests"}},
		{"parameter name", "/api/saved-queries?q=minimum", []string{"requests"}},
		{"query text", "/api/saved-queries?q=histogram_quantile", []string{"latency"}},
		{"combined with providerId", "/api/saved-queries?providerId=metrics&q=requests", []string{"requests"}},
		{"providerId excludes", "/api/saved-queries?providerId=other&q=requests", []string{}},
		{"summary keeps the filter", "/api/saved-queries?summary=true&q=api", []string{"latency"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := request(t, h, "GET", tc.path, nil, nil)
			require.ElementsMatch(t, tc.want, savedQueryListIDs(t, w))
		})
	}
	w := request(t, h, "GET", "/api/saved-queries?q=nothing-like-this", nil, nil)
	require.Equal(t, 200, w.Code)
	require.JSONEq(t, `{"queries":[]}`, w.Body.String())
}

func TestSavedQueryListRejectsLongQ(t *testing.T) {
	h := savedQueryListFixture(t)
	w := request(t, h, "GET", "/api/saved-queries?q="+strings.Repeat("%C3%A9", 257), nil, nil)
	require.Equal(t, 400, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "q must be at most 256 characters")
	w = request(t, h, "GET", "/api/saved-queries?q="+strings.Repeat("%C3%A9", 256), nil, nil)
	require.Equal(t, 200, w.Code, w.Body.String())
}

func TestSavedQuerySummaryBoundsQueryAndListsParameterNames(t *testing.T) {
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	s, _ := testService(t, provider)
	h := s.Handler()
	long := savedQueryDocument("long")
	long["query"] = strings.Repeat("é", 300)
	long["parameters"] = []any{map[string]any{"name": "service", "type": "string", "label": "Service", "defaultValue": "api"}}
	putSavedQueryForList(t, h, "long", long)
	short := map[string]any{"schemaVersion": 1, "id": "short", "name": "Short", "providerId": "metrics", "kind": "metrics", "query": "up"}
	putSavedQueryForList(t, h, "short", short)

	w := request(t, h, "GET", "/api/saved-queries?summary=true", nil, nil)
	require.Equal(t, 200, w.Code, w.Body.String())
	var result struct {
		Queries []map[string]json.RawMessage `json:"queries"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.Len(t, result.Queries, 2)
	byID := map[string]map[string]json.RawMessage{}
	for _, query := range result.Queries {
		var id string
		require.NoError(t, json.Unmarshal(query["id"], &id))
		byID[id] = query
	}

	var text string
	require.NoError(t, json.Unmarshal(byID["long"]["query"], &text))
	require.Equal(t, 256, len([]rune(text)))
	require.JSONEq(t, `true`, string(byID["long"]["queryTruncated"]))
	require.JSONEq(t, `[{"name":"service"}]`, string(byID["long"]["parameters"]))
	require.NotContains(t, w.Body.String(), `"label"`)
	require.NotContains(t, string(byID["long"]["parameters"]), "Service")

	require.NotContains(t, byID["short"], "queryTruncated")
	require.NotContains(t, byID["short"], "parameters")
	require.JSONEq(t, `"up"`, string(byID["short"]["query"]))
}
