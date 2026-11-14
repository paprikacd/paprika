package insights

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// dashboardCappedGoldenDir holds the capped wire output that the observability gateway validates
// against its advertised schema. It is the output of writeDashboardQueryResult, the handler's writer.
const dashboardCappedGoldenDir = "testdata/dashboard_query_capped"

// cappedGoldenFixture is a complete query-dashboard result: the breach, band series, freshness and
// sample fixture of withStatWidgets, with every top-level field the advertised schema requires.
func cappedGoldenFixture() *DashboardQueryResult {
	result := withStatWidgets()
	result.ObservedAt = "2026-10-26T01:00:00Z"
	result.Range = DashboardQueryRange{Start: "2026-10-26T00:00:00Z", End: "2026-10-26T01:00:00Z", StepSeconds: 60}
	result.Dashboard.ETag = "v1"
	result.Variables = map[string]string{}
	result.SavedQueries = []DashboardQueryDocument{}
	result.Signals = []DashboardSignal{{ID: "q1", Kind: "metrics", ProviderID: "prometheus", State: "ok"}}
	result.QueryCount = DashboardQueryCount{Planned: 1, Executed: 1}
	result.State = "ok"
	return result
}

// TestDashboardCappedGoldens pins the capped wire output after each prefix of the ladder. The fixture
// holds breach objects, band series, time-series freshness, stat freshness and samples, and each file
// is sized so that exactly n steps are needed and the result is exactly the cap. Regenerate with
// UPDATE_DASHBOARD_CAPPED_GOLDEN=1 go test ./internal/insights -run TestDashboardCappedGoldens.
func TestDashboardCappedGoldens(t *testing.T) {
	for n := 1; n <= len(dashboardOmissionSteps); n++ {
		result := cappedGoldenFixture()
		result.Dashboard.Title = fillerForStepsOf(t, cappedGoldenFixture, n)
		w := httptest.NewRecorder()
		writeDashboardQueryResult(w, result)
		require.Equal(t, http.StatusOK, w.Code, "the capped fixture must fit after %d steps", n)
		require.Equal(t, DashboardQueryResponseBytes, w.Body.Len())
		require.Equal(t, dashboardOmissionStepNamesThrough(n), result.Omitted)

		path := filepath.Join(dashboardCappedGoldenDir, fmt.Sprintf("steps-%d.json", n))
		if os.Getenv("UPDATE_DASHBOARD_CAPPED_GOLDEN") == "1" {
			require.NoError(t, os.WriteFile(path, w.Body.Bytes(), 0o600))
			continue
		}
		golden, err := os.ReadFile(path) //nolint:gosec // Fixed fixture names under testdata, never request input.
		require.NoError(t, err, "read golden (set UPDATE_DASHBOARD_CAPPED_GOLDEN=1 to write it)")
		require.True(t, bytes.Equal(golden, w.Body.Bytes()), "capped wire output changed after %d steps; regenerate %s with UPDATE_DASHBOARD_CAPPED_GOLDEN=1", n, path)
	}
}
