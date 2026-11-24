package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// sourcedDashboardWithSavedQuery stores a dashboard with a label source, a dependent label source and a
// saved-query source, and the saved query the last one reads.
func sourcedDashboardWithSavedQuery(t *testing.T, s *Server) {
	t.Helper()
	saved := map[string]any{"schemaVersion": 1, "id": "hosts", "name": "Hosts", "providerId": "prometheus", "kind": "metrics", "query": "up"}
	raw, err := json.Marshal(saved)
	require.NoError(t, err)
	saveResponse := request(t, s.Handler(), "PUT", "/api/saved-queries/hosts", raw, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, saveResponse.Code, saveResponse.Body.String())
	document := map[string]any{"schemaVersion": 1, "id": "overview", "title": "Service overview", "timeRange": "1h", "refreshInterval": 30, "widgets": []any{}, "variables": []any{
		map[string]any{"name": "zone", "label": "Zone", "source": map[string]any{"type": "labelValues", "providerId": "prometheus", "label": "zone"}},
		map[string]any{"name": "pod", "label": "Pod", "source": map[string]any{"type": "labelValues", "providerId": "prometheus", "label": "pod", "selector": "up{zone={{zone}}}"}},
		map[string]any{"name": "service", "label": "Service", "source": map[string]any{"type": "savedQuery", "queryRef": map[string]any{"id": "hosts", "bindings": []any{}}, "field": "service"}},
	}}
	raw, err = json.Marshal(document)
	require.NoError(t, err)
	_, err = s.store.Put("overview", raw, "", "*")
	require.NoError(t, err)
}

func TestDashboardQueryResolvesVariableSources(t *testing.T) {
	fake := &variableSourceServer{}
	provider := httptest.NewServer(fake.handler(0))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	sourcedDashboardWithSavedQuery(t, s)

	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","variables":{"zone":"zz"}}`), nil)
	result := readDashboardResult(t, w)

	require.Len(t, result.VariableDefinitions, 3)
	zone := result.VariableDefinitions[0].SourceOptions
	require.NotNil(t, zone)
	require.Equal(t, "ready", zone.State)
	require.Equal(t, []string{"a", "b"}, zone.Values)
	require.Equal(t, "not_in_values", zone.CurrentValue, "zz is kept, marked as absent from the source's values")
	require.Equal(t, "zz", valueText(result.Variables["zone"]), "the override still applies")

	pod := result.VariableDefinitions[1].SourceOptions
	require.NotNil(t, pod)
	require.Equal(t, "ready", pod.State)
	require.Equal(t, []string{"p1"}, pod.Values, "the selector reads the override")
	require.Empty(t, pod.CurrentValue, "pod has no current value")

	service := result.VariableDefinitions[2].SourceOptions
	require.NotNil(t, service)
	require.Equal(t, "ready", service.State)
	require.Equal(t, []string{"api", "db"}, service.Values, "a saved-query source reads the field's series labels")

	require.Contains(t, result.Warnings, "zone=zz is not one of the values its source returned")
	require.NotNil(t, result.QueryCount.VariableOptions)
	require.Equal(t, 3, result.QueryCount.VariableOptions.Planned)
	require.Equal(t, 3, result.QueryCount.VariableOptions.Executed)
	require.Len(t, result.SavedQueries, 1)
	require.Equal(t, "hosts", result.SavedQueries[0].ID, "the source's saved query is listed once")
	require.NotEmpty(t, result.SavedQueries[0].ETag)
}

// TestDashboardQueryVariableSourceBudgetOmitsValuesPastTheBudget checks that the values of all sourced variables
// share one encoded byte budget. A value past it is counted in valuesOmitted, and no value is dropped silently.
// Label values over 256 bytes are dropped by the provider metadata path, so each value here is 200 bytes: 100 of
// them still exceed the 16 KiB budget.
func TestDashboardQueryVariableSourceBudgetOmitsValuesPastTheBudget(t *testing.T) {
	long := strings.Repeat("v", 200)
	values := make([]string, 0, 100)
	for index := range 100 {
		values = append(values, fmt.Sprintf("%03d-%s", index, long))
	}
	body, err := json.Marshal(map[string]any{"status": "success", "data": values})
	require.NoError(t, err)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	sourcedDashboardWithSavedQuery(t, s)

	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","variables":{"zone":"000-`+long+`"}}`), nil)
	result := readDashboardResult(t, w)

	zone := result.VariableDefinitions[0].SourceOptions
	require.NotNil(t, zone)
	require.Equal(t, "ready", zone.State)
	require.Less(t, len(zone.Values), 100, "the value budget keeps only part of the list")
	require.Positive(t, zone.ValuesOmitted)
	require.Equal(t, 100, len(zone.Values)+zone.ValuesOmitted, "every value is either kept or counted")
	require.Equal(t, "in_values", zone.CurrentValue, "the current value is found on the full list before the budget")
}

// TestDashboardVariableOptionsDropKeepsTheCount checks the first omission step: it removes the listed values and
// counts them, and it keeps the state.
func TestDashboardVariableOptionsDropKeepsTheCount(t *testing.T) {
	result := &DashboardQueryResult{VariableDefinitions: []DashboardQueryVariable{
		{Name: "zone", SourceOptions: &DashboardVariableSourceOptions{State: "ready", Values: []string{"a", "b", "c"}, CurrentValue: "in_values"}},
		{Name: "plain"},
	}}
	require.True(t, dashboardOmissionStepNamed(t, "variableOptions").drop(result))
	options := result.VariableDefinitions[0].SourceOptions
	require.Nil(t, options.Values)
	require.Equal(t, 3, options.ValuesOmitted)
	require.Equal(t, "ready", options.State)
	require.Equal(t, "in_values", options.CurrentValue)
	require.False(t, dashboardOmissionStepNamed(t, "variableOptions").drop(result), "a second drop has nothing left to remove")
}
