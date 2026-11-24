package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

func TestDashboardVariableValuesApplyTheDeclaration(t *testing.T) {
	definitions := []dashboardReadVariable{
		{Name: "cluster", Multi: true, AllowAll: true, Options: []string{"omega", "delta"}},
		{Name: "region", Options: []string{"eu", "us"}},
	}

	values, err := dashboardVariableValues(definitions, map[string]variablevalue.Value{"cluster": variablevalue.Single("omega")})
	require.NoError(t, err)
	require.Equal(t, variablevalue.List([]string{"omega"}), values["cluster"], "a string for a multi variable is one item")

	values, err = dashboardVariableValues(definitions, map[string]variablevalue.Value{"cluster": variablevalue.List(nil)})
	require.NoError(t, err)
	require.Equal(t, variablevalue.List(nil), values["cluster"], "an empty list is All")

	_, err = dashboardVariableValues(definitions, map[string]variablevalue.Value{"region": variablevalue.List([]string{"eu"})})
	require.Error(t, err, "a list for a single-value variable is refused")
}

func TestDashboardWidgetQueryExpandsAListAsAnAlternation(t *testing.T) {
	definitions := []dashboardReadVariable{{Name: "cluster", Multi: true, Options: []string{"omega", "delta"}}}
	widget := &dashboardReadWidget{ID: "w", Type: "timeseries", Query: `up{cluster=~{{cluster}}}`}

	query, failure := resolveDashboardWidget(widget, nil, map[string]variablevalue.Value{
		"cluster": variablevalue.List([]string{"omega", "delta"}),
	}, definitions)
	require.Nil(t, failure)
	require.Equal(t, `up{cluster=~"omega|delta"}`, query.Query)
}

// The query-dashboard endpoint, which query_dashboard calls, takes a list for a multi variable and sends the provider
// one escaped alternation; All sends .+. Before this, the request check refused every non-string value.
func TestQueryDashboardEndpointTakesListValues(t *testing.T) {
	var mu sync.Mutex
	var received []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		received = append(received, r.URL.Query().Get("query"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"60", "1"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document, err := json.Marshal(map[string]any{"schemaVersion": 1, "id": "overview", "title": "Clusters", "timeRange": "1h", "refreshInterval": 30,
		"variables": []any{map[string]any{"name": "cluster", "multi": true, "allowAll": true, "defaultValue": []string{"omega"}, "options": []string{"omega", "delta", "eu.central"}}},
		"widgets":   []any{queryReadWidget("w", `up{cluster=~{{cluster}}}`)}})
	require.NoError(t, err)
	_, err = s.store.Put("overview", document, "", "*")
	require.NoError(t, err)

	for _, test := range []struct {
		variables string
		want      string
		resolved  []string
	}{
		{variables: `{"cluster":["omega","eu.central"]}`, want: `up{cluster=~"omega|eu\\.central"}`, resolved: []string{"omega", "eu.central"}},
		{variables: `{"cluster":[]}`, want: `up{cluster=~".+"}`, resolved: []string{}},
		{variables: `{"cluster":"delta"}`, want: `up{cluster=~"delta"}`, resolved: []string{"delta"}},
	} {
		result := readDashboardResult(t, request(t, s.Handler(), http.MethodPost, "/api/query-dashboard", []byte(`{"id":"overview","variables":`+test.variables+`,`+dashboardQueryWindow+`}`), nil))
		require.Equal(t, variablevalue.List(test.resolved), result.Variables["cluster"], test.variables)
		mu.Lock()
		require.Contains(t, received, test.want, test.variables)
		mu.Unlock()
	}

	for _, refused := range []string{`{"cluster":[1]}`, `{"cluster":["a","a"]}`, `{"cluster":null}`} {
		w := request(t, s.Handler(), http.MethodPost, "/api/query-dashboard", []byte(`{"id":"overview","variables":`+refused+`,`+dashboardQueryWindow+`}`), nil)
		require.Equal(t, http.StatusBadRequest, w.Code, refused)
	}
}

func TestDashboardWidgetQueryRefusesAListAfterEquality(t *testing.T) {
	definitions := []dashboardReadVariable{{Name: "cluster", Multi: true, Options: []string{"omega"}}}
	widget := &dashboardReadWidget{ID: "w", Type: "timeseries", Query: `up{cluster={{cluster}}}`}

	_, failure := resolveDashboardWidget(widget, nil, map[string]variablevalue.Value{
		"cluster": variablevalue.List([]string{"omega"}),
	}, definitions)
	require.NotNil(t, failure, "equality cannot take several values")
}
