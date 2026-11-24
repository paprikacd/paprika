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

// A shared provider's source is resolved with the caller's delegated identity, never the service token, and a
// catalog that refuses or is busy reports the source as failed with the matching code instead of an empty list.
func TestDashboardVariableOptionsUseTheCallersSharedIdentity(t *testing.T) {
	for _, tc := range []struct {
		name    string
		catalog int
		state   string
		values  []string
		code    string
	}{
		{"allowed", http.StatusOK, "VARIABLE_OPTIONS_STATE_READY", []string{"alice"}, ""},
		{"forbidden", http.StatusForbidden, "VARIABLE_OPTIONS_STATE_FAILED", nil, "forbidden"},
		{"busy", http.StatusTooManyRequests, "VARIABLE_OPTIONS_STATE_FAILED", nil, "rate_limited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				if token != "alice" {
					t.Errorf("gateway received a service token or another caller: %q", token)
				}
				switch r.URL.Path {
				case "/list_observability_providers":
					if tc.catalog != http.StatusOK {
						writeJSON(w, tc.catalog, map[string]any{"error": "refused"})
						return
					}
					writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
				case "/list_label_values":
					// The value is the caller's token, so the test sees whose identity read the values.
					writeJSON(w, 200, map[string]any{"state": "OK", "data": map[string]any{"status": "success", "data": []string{token}}})
				default:
					t.Errorf("unexpected gateway path: %s", r.URL.Path)
				}
			}))
			defer gateway.Close()
			s := observeTestService(t, gateway.URL)
			document := map[string]any{"schemaVersion": 1, "id": "shared", "title": "Shared", "timeRange": "1h", "refreshInterval": 30, "widgets": []any{}, "variables": []any{
				map[string]any{"name": "service", "label": "Service", "source": map[string]any{"type": "labelValues", "providerId": observeProviderID("prod/prom"), "label": "service"}},
			}}
			raw, err := json.Marshal(document)
			require.NoError(t, err)
			_, err = s.store.Put("shared", raw, "", "*")
			require.NoError(t, err)

			w := request(t, s.Handler(), "POST", "/api/dashboards/shared/variable-options", []byte(`{}`), observeHeaders("alice"))
			body := readVariableOptions(t, w)
			require.Len(t, body.Variables, 1)
			require.Equal(t, tc.state, body.Variables[0].State)
			require.ElementsMatch(t, tc.values, body.Variables[0].Values)
			require.Equal(t, tc.code, body.Variables[0].ErrorCode)
		})
	}
}
