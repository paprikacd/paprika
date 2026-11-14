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
	require.Contains(t, text, "Omitted from structuredContent to fit the result cap, in this order: listed breach intervals and their series names (window summaries kept); time-series freshness, the limit, lastTimestamp and age of stale samples, samples whose state is not stale, and stale samples on widgets already marked stale; mystery. Attention counts are unchanged. Narrow the query with widget_ids to get the omitted detail back.")

	raw = json.RawMessage(`{"schemaVersion":1,"dashboard":{"id":"overview","etag":"v1"},"state":"ok","widgets":[],"signals":[]}`)
	text, err = dashboardQueryText(raw)
	require.NoError(t, err)
	require.False(t, strings.Contains(text, "Omitted from structuredContent"), "a result that fits says nothing about omission")
}

// A breach line separates intervals it lists but does not show from intervals structuredContent does
// not list at all. After the first omission step the listed intervals are gone, so only the count of
// intervals not listed remains, and the omission line says how to get the detail back.
func TestDashboardBreachTextSeparatesListedFromNotListedIntervals(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"dashboard":{"id":"overview","etag":"v1"},"state":"ok",` +
		`"widgets":[` +
		`{"id":"listed","title":"Listed","type":"timeseries","unit":"","signalId":"q1","breaches":{"seriesEvaluated":1,"intervalsOmitted":0,` +
		`"intervals":[{"series":0,"name":"a","level":"critical","start":1000,"end":2000,"durationMs":1000},{"series":0,"name":"a","level":"critical","start":3000,"end":4000,"durationMs":1000},{"series":0,"name":"a","level":"critical","start":5000,"end":6000,"durationMs":1000},{"series":0,"name":"a","level":"critical","start":7000,"end":8000,"durationMs":1000},{"series":0,"name":"a","level":"critical","start":9000,"end":9500,"durationMs":500}],` +
		`"summary":[{"level":"critical","intervals":5,"samples":0,"durationMs":4500}],"latestLevel":"critical"}},` +
		`{"id":"dropped","title":"Dropped","type":"timeseries","unit":"","signalId":"q1","breaches":{"seriesEvaluated":1,"intervals":[],"intervalsOmitted":259,` +
		`"summary":[{"level":"critical","intervals":259,"samples":0,"durationMs":900000}],"latestLevel":"critical"}}` +
		`],"signals":[{"id":"q1","kind":"metrics","state":"ok"}],"omitted":["breachIntervals"]}`)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, `(2 more listed in structuredContent)`, "listed intervals beyond the three shown are named as listed")
	require.Contains(t, text, `(259 not listed)`, "intervals structuredContent does not list are counted apart")
	require.NotContains(t, text, "more intervals in structuredContent", "the old wording claimed detail that the structured result does not hold")
	require.Contains(t, text, "Narrow the query with widget_ids to get the omitted detail back.")
}
