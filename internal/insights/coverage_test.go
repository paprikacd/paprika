package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// coverageDocument is a valid one-widget dashboard. fields is a run of top-level members, each ending in a comma.
func coverageDocument(id, fields string) []byte {
	return []byte(fmt.Sprintf(`{"schemaVersion":1,"id":%q,"title":"Title %s","timeRange":"1h","refreshInterval":0,%s"widgets":[{"id":"up","title":"Up","type":"stat","providerId":"prometheus","query":"up","unit":"","layout":{"x":0,"y":0,"w":4,"h":2}}]}`, id, id, fields))
}

type applicationDashboardsResponse struct {
	Dashboards []struct {
		ID                string            `json:"id"`
		Variables         map[string]string `json:"variables"`
		SummaryWidgetID   string            `json:"summaryWidgetId"`
		SummaryWidgetRows uint32            `json:"summaryWidgetRows"`
		Specificity       uint32            `json:"specificity"`
	} `json:"dashboards"`
	Truncated bool `json:"truncated"`
}

func lookupApplicationDashboards(t *testing.T, h http.Handler, query string) (*applicationDashboardsResponse, int) {
	t.Helper()
	recorder := request(t, h, http.MethodGet, "/api/application-dashboards?"+query, nil, nil)
	if recorder.Code != http.StatusOK {
		return nil, recorder.Code
	}
	var body applicationDashboardsResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return &body, recorder.Code
}

func TestApplicationDashboardsOrderBySpecificityAndCoverage(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	for id, fields := range map[string]string{
		"all":          `"covers":{"applications":[{}]},`,
		"by-name":      `"covers":{"applications":[{"name":"checkout"}]},`,
		"by-namespace": `"covers":{"applications":[{"namespace":"payments"}]},`,
		"exact":        `"covers":{"applications":[{"namespace":"payments","name":"checkout"}]},`,
		"elsewhere":    `"covers":{"applications":[{"namespace":"other"}]},`,
		"uncovered":    ``,
	} {
		require.Equal(t, http.StatusOK, request(t, h, http.MethodPut, "/api/dashboards/"+id, coverageDocument(id, fields), map[string]string{"If-None-Match": "*"}).Code, id)
	}

	found, code := lookupApplicationDashboards(t, h, "namespace=payments&name=checkout")
	require.Equal(t, http.StatusOK, code)
	require.False(t, found.Truncated)
	ids := make([]string, 0, len(found.Dashboards))
	for _, dashboard := range found.Dashboards {
		ids = append(ids, dashboard.ID)
	}
	require.Equal(t, []string{"exact", "by-name", "by-namespace", "all"}, ids)
	require.Equal(t, uint32(3), found.Dashboards[0].Specificity)
	require.Equal(t, uint32(0), found.Dashboards[3].Specificity)
	require.Zero(t, found.Dashboards[0].SummaryWidgetRows, "no summary widget, no height")

	other, _ := lookupApplicationDashboards(t, h, "namespace=payments&name=billing")
	require.Len(t, other.Dashboards, 2)
	require.Equal(t, "by-namespace", other.Dashboards[0].ID)
}

func TestApplicationDashboardsCapAtEightAndReportTruncation(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	for i := range 9 {
		id := fmt.Sprintf("broad-%d", i)
		require.Equal(t, http.StatusOK, request(t, h, http.MethodPut, "/api/dashboards/"+id, coverageDocument(id, `"covers":{"applications":[{}]},`), map[string]string{"If-None-Match": "*"}).Code)
	}
	found, _ := lookupApplicationDashboards(t, h, "namespace=payments&name=checkout")
	require.Len(t, found.Dashboards, 8)
	require.True(t, found.Truncated)
}

func TestApplicationDashboardsOmitVariableValuesOutsideOptions(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	fields := `"variables":[{"name":"service","options":["api","web"]},{"name":"namespace"}],"covers":{"applications":[{}],"variables":{"service":"name","namespace":"namespace"},"summaryWidget":"up"},`
	require.Equal(t, http.StatusOK, request(t, h, http.MethodPut, "/api/dashboards/services", coverageDocument("services", fields), map[string]string{"If-None-Match": "*"}).Code)

	listed, _ := lookupApplicationDashboards(t, h, "namespace=payments&name=checkout")
	require.Len(t, listed.Dashboards, 1)
	require.Equal(t, map[string]string{"namespace": "payments"}, listed.Dashboards[0].Variables)
	require.Equal(t, "up", listed.Dashboards[0].SummaryWidgetID)
	require.Equal(t, uint32(2), listed.Dashboards[0].SummaryWidgetRows, "the summary widget's saved height sizes its frame")

	withOption, _ := lookupApplicationDashboards(t, h, "namespace=payments&name=api")
	require.Equal(t, map[string]string{"service": "api", "namespace": "payments"}, withOption.Dashboards[0].Variables)
}

func TestApplicationDashboardsRequireValidApplicationNames(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	for _, query := range []string{"name=checkout", "namespace=payments", "namespace=Payments&name=checkout", "namespace=payments&name=checkout%20x"} {
		_, code := lookupApplicationDashboards(t, h, query)
		require.Equal(t, http.StatusBadRequest, code, query)
	}
}

func TestApplicationDashboardsHonourETags(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	first := request(t, h, http.MethodGet, "/api/application-dashboards?namespace=payments&name=checkout", nil, nil)
	require.Equal(t, http.StatusOK, first.Code)
	tag := first.Header().Get("ETag")
	require.NotEmpty(t, tag)
	cached := request(t, h, http.MethodGet, "/api/application-dashboards?namespace=payments&name=checkout", nil, map[string]string{"If-None-Match": tag})
	require.Equal(t, http.StatusNotModified, cached.Code)
}

func TestValidateDashboardCoversRejectsUndeclaredVariablesAndUnknownWidgets(t *testing.T) {
	require.Error(t, validateDashboard("demo", Dashboard(coverageDocument("demo", `"covers":{"applications":[{}],"variables":{"service":"name"}},`))))
	require.Error(t, validateDashboard("demo", Dashboard(coverageDocument("demo", `"covers":{"applications":[{}],"summaryWidget":"missing"},`))))
	require.NoError(t, validateDashboard("demo", Dashboard(coverageDocument("demo", `"covers":{"applications":[{"namespace":"payments"}]},`))))
}
