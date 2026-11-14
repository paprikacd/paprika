package observabilitygateway

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights"
)

// The gateway reads at most dashboardQueryResponseBytes of an Insights query-dashboard response,
// so it must equal the Insights cap the server enforces after omitting optional detail.
func TestDashboardQueryResponseCapMatchesInsights(t *testing.T) {
	require.Equal(t, insights.DashboardQueryResponseBytes, dashboardQueryResponseBytes)
}

// The text summary states what was omitted to fit the cap, in order, so a text-only reader knows the
// structured output carries less detail than the widgets had. A result with nothing omitted says nothing.
func TestDashboardQueryTextNamesOmittedDetail(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"dashboard":{"id":"overview","etag":"v1"},"state":"ok","omitted":["breachIntervals","sample","mystery"],"widgets":[],"signals":[]}`)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, "Omitted from structuredContent to fit the result cap, in this order: listed breach intervals and their series names (window summaries kept); sample limit and age detail (state kept); mystery. Attention counts are unchanged.")

	raw = json.RawMessage(`{"schemaVersion":1,"dashboard":{"id":"overview","etag":"v1"},"state":"ok","widgets":[],"signals":[]}`)
	text, err = dashboardQueryText(raw)
	require.NoError(t, err)
	require.False(t, strings.Contains(text, "Omitted from structuredContent"), "a result that fits says nothing about omission")
}
