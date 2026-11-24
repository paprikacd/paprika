package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// variableOptionsBody mirrors the protojson wire form of VariableOptionsResponse.
type variableOptionsBody struct {
	DashboardEtag string `json:"dashboardEtag"`
	RangeStart    string `json:"rangeStart"`
	RangeEnd      string `json:"rangeEnd"`
	Variables     []struct {
		Name          string   `json:"name"`
		State         string   `json:"state"`
		Values        []string `json:"values"`
		CurrentValue  string   `json:"currentValue"`
		NeedsVariable string   `json:"needsVariable"`
		ErrorCode     string   `json:"errorCode"`
	} `json:"variables"`
}

// putSourcedDashboard stores a dashboard with a label source, a dependent label source and a plain variable.
func putSourcedDashboard(t *testing.T, s *Server) {
	t.Helper()
	document := map[string]any{"schemaVersion": 1, "id": "overview", "title": "Service overview", "timeRange": "1h", "refreshInterval": 30, "widgets": []any{}, "variables": []any{
		map[string]any{"name": "zone", "label": "Zone", "source": map[string]any{"type": "labelValues", "providerId": "prometheus", "label": "zone"}},
		map[string]any{"name": "pod", "label": "Pod", "source": map[string]any{"type": "labelValues", "providerId": "prometheus", "label": "pod", "selector": "up{zone={{zone}}}"}},
		map[string]any{"name": "plain", "label": "Plain", "defaultValue": "x"},
	}}
	raw, err := json.Marshal(document)
	require.NoError(t, err)
	_, err = s.store.Put("overview", raw, "", "*")
	require.NoError(t, err)
}

func variableOptionsTestService(t *testing.T) (*Server, *variableSourceServer) {
	t.Helper()
	fake := &variableSourceServer{}
	provider := httptest.NewServer(fake.handler(0))
	t.Cleanup(provider.Close)
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putSourcedDashboard(t, s)
	return s, fake
}

func readVariableOptions(t *testing.T, w *httptest.ResponseRecorder) variableOptionsBody {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body variableOptionsBody
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body), w.Body.String())
	return body
}

func TestDashboardVariableOptionsResolvesEverySourcedVariable(t *testing.T) {
	s, _ := variableOptionsTestService(t)
	w := request(t, s.Handler(), "POST", "/api/dashboards/overview/variable-options", []byte(`{"variables":{"zone":"a"}}`), nil)
	body := readVariableOptions(t, w)
	require.NotEmpty(t, body.DashboardEtag)
	from, err := time.Parse(time.RFC3339, body.RangeStart)
	require.NoError(t, err)
	to, err := time.Parse(time.RFC3339, body.RangeEnd)
	require.NoError(t, err)
	require.Zero(t, from.Unix()%variableRangeBucketSeconds, "the range start is bucketed to the minute")
	require.Zero(t, to.Unix()%variableRangeBucketSeconds, "the range end is bucketed to the minute")
	require.True(t, to.After(from))
	require.Len(t, body.Variables, 2, "the plain variable has no source")
	require.Equal(t, "zone", body.Variables[0].Name)
	require.Equal(t, "VARIABLE_OPTIONS_STATE_READY", body.Variables[0].State)
	require.Equal(t, []string{"a", "b"}, body.Variables[0].Values)
	require.Equal(t, "CURRENT_VALUE_IN_VALUES", body.Variables[0].CurrentValue)
	require.Equal(t, "pod", body.Variables[1].Name)
	require.Equal(t, []string{"p1"}, body.Variables[1].Values)
	require.Equal(t, "CURRENT_VALUE_NONE", body.Variables[1].CurrentValue, "pod has no current value")
}

func TestDashboardVariableOptionsNamesSelectAndReportNeedsVariable(t *testing.T) {
	s, _ := variableOptionsTestService(t)
	w := request(t, s.Handler(), "POST", "/api/dashboards/overview/variable-options", []byte(`{"names":["pod"]}`), nil)
	body := readVariableOptions(t, w)
	require.Len(t, body.Variables, 1)
	require.Equal(t, "pod", body.Variables[0].Name)
	require.Equal(t, "VARIABLE_OPTIONS_STATE_NEEDS_VARIABLE", body.Variables[0].State, "pod needs zone and no value is given")
	require.Equal(t, "zone", body.Variables[0].NeedsVariable)
}

func TestDashboardVariableOptionsRejectsBadRequests(t *testing.T) {
	s, _ := variableOptionsTestService(t)
	h := s.Handler()
	for _, tc := range []struct {
		name   string
		path   string
		body   string
		status int
		text   string
	}{
		{"unknown name", "/api/dashboards/overview/variable-options", `{"names":["plain"]}`, http.StatusBadRequest, "names must name dashboard variables that declare a source"},
		{"unknown field", "/api/dashboards/overview/variable-options", `{"bogus":1}`, http.StatusBadRequest, "invalid variable options request"},
		{"too many names", "/api/dashboards/overview/variable-options", `{"names":["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u"]}`, http.StatusBadRequest, "names must name at most 20 variables"},
		{"undeclared variable value", "/api/dashboards/overview/variable-options", `{"variables":{"nope":"x"}}`, http.StatusBadRequest, "variables must name declared dashboard variables"},
		{"invalid range", "/api/dashboards/overview/variable-options", `{"start":"yesterday","end":"today"}`, http.StatusBadRequest, "RFC3339"},
		{"missing dashboard", "/api/dashboards/missing/variable-options", `{}`, http.StatusNotFound, "not found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := request(t, h, "POST", tc.path, []byte(tc.body), nil)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			require.Contains(t, strings.ToLower(w.Body.String()), strings.ToLower(tc.text))
		})
	}
}
