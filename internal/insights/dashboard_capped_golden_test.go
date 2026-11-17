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

// dashboardCappedGoldenFiller stands in for the title filler in a stored golden. The filler exists only
// to land each result exactly on the cap, so storing it would commit about 130 KB per file to the repo.
const dashboardCappedGoldenFiller = "<filler>"

// cappedGoldenFixture is a complete query-dashboard result: the breach, band series, freshness and
// sample fixture of withStatWidgets, with every top-level field the advertised schema requires. Its
// attention counts 52 widgets, all checked, with 48 critical breach widgets and 4 stale stats.
func cappedGoldenFixture() *DashboardQueryResult {
	result := withStatWidgets()
	result.Attention = DashboardAttention{Basis: dashboardAttentionBasis, Widgets: 52, Checked: 52, Critical: 48, Stale: 4}
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
// is sized so that exactly n steps are needed and the result is exactly the cap. The title filler is
// stored as dashboardCappedGoldenFiller, so each golden is small and compares after that replacement.
// Regenerate with UPDATE_DASHBOARD_CAPPED_GOLDEN=1 go test ./internal/insights -run TestDashboardCappedGoldens.
// The ladder never changes attention, so every prefix must carry the fixture's attention counts.
func TestDashboardCappedGoldens(t *testing.T) {
	wantAttention := cappedGoldenFixture().Attention
	require.Equal(t, 52, wantAttention.Widgets, "the golden fixture must carry real attention counts")
	require.Equal(t, 52, wantAttention.Checked, "every widget in the golden fixture carries samples, so all 52 are checked")
	require.Equal(t, 48, wantAttention.Critical)
	require.Equal(t, 4, wantAttention.Stale)
	for n := 1; n <= len(dashboardOmissionSteps); n++ {
		result := cappedGoldenFixture()
		filler := fillerForStepsOf(t, cappedGoldenFixture, n)
		result.Dashboard.Title = filler
		w := httptest.NewRecorder()
		writeDashboardQueryResult(w, result)
		require.Equal(t, http.StatusOK, w.Code, "the capped fixture must fit after %d steps", n)
		require.Equal(t, DashboardQueryResponseBytes, w.Body.Len())
		require.Equal(t, dashboardOmissionStepNamesThrough(n), result.Omitted)
		require.Equal(t, wantAttention, result.Attention, "attention is unchanged after %d steps", n)

		stored := bytes.Replace(w.Body.Bytes(), []byte(`"`+filler+`"`), []byte(`"`+dashboardCappedGoldenFiller+`"`), 1)
		require.NotEqual(t, w.Body.Len(), len(stored), "the filler must be replaced in the stored golden after %d steps", n)
		path := filepath.Join(dashboardCappedGoldenDir, fmt.Sprintf("steps-%d.json", n))
		if os.Getenv("UPDATE_DASHBOARD_CAPPED_GOLDEN") == "1" {
			require.NoError(t, os.WriteFile(path, stored, 0o600))
			continue
		}
		golden, err := os.ReadFile(path) //nolint:gosec // Fixed fixture names under testdata, never request input.
		require.NoError(t, err, "read golden (set UPDATE_DASHBOARD_CAPPED_GOLDEN=1 to write it)")
		require.True(t, bytes.Equal(golden, stored), "capped wire output changed after %d steps; regenerate %s with UPDATE_DASHBOARD_CAPPED_GOLDEN=1", n, path)
	}
}
