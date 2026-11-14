package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// oversizedWidgetsDocument builds a schema-broken document whose widgets array holds
// n copies of element. Both element shapes below fail the widget shape check.
func oversizedWidgetsDocument(n int, element string) Dashboard {
	var b strings.Builder
	b.WriteString(`{"schemaVersion":1,"id":"demo","title":"Big","timeRange":"1h","refreshInterval":30,"widgets":[`)
	for i := range n {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(element)
	}
	b.WriteString("]}")
	return Dashboard(b.String())
}

// reportBody is the part of a check report or a rejected save these tests read.
type reportBody struct {
	Total        uint32 `json:"total"`
	Truncated    bool   `json:"truncated"`
	ErrorCount   uint32 `json:"errorCount"`
	WarningCount uint32 `json:"warningCount"`
	InfoCount    uint32 `json:"infoCount"`
	Issues       []struct {
		RuleID string `json:"ruleId"`
	} `json:"issues"`
}

// An oversized widgets array costs a bounded amount, whatever its length: the
// report counts every widget as a failure, but only the first widgets are checked
// and only the first findings are built. The totals still describe the request:
// one count finding plus one shape failure for each of the first 48 widgets.
func TestOversizedWidgetArrayStaysWithinAllocationBudget(t *testing.T) {
	for name, element := range map[string]string{"empty objects": "{}", "numbers": "1"} {
		t.Run(name, func(t *testing.T) {
			s, _ := testService(t)
			h := s.Handler()
			document := oversizedWidgetsDocument(87000, element)
			require.LessOrEqual(t, len(document), maxDocumentBytes)
			// Build the request bodies before measuring, so only the service's work counts.
			dryRun := checkBody(document)
			saved := []byte(document)

			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			w := request(t, h, "POST", "/api/dashboards/validate", dryRun, nil)
			runtime.ReadMemStats(&after)
			require.Equal(t, http.StatusOK, w.Code, "dry run body %.200s", w.Body)
			require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(16<<20), "dry run allocated too much")
			assertOversizedReport(t, w.Body.Bytes())

			runtime.ReadMemStats(&before)
			w = request(t, h, "PUT", "/api/dashboards/demo?checks=true", saved, map[string]string{"If-None-Match": "*"})
			runtime.ReadMemStats(&after)
			require.Equal(t, http.StatusBadRequest, w.Code, "save body %.200s", w.Body)
			require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(16<<20), "save allocated too much")
			assertOversizedReport(t, w.Body.Bytes())
		})
	}
}

// assertOversizedReport checks the totals of an over-limit report. The count finding
// comes first, so the capped issue list starts with it.
func assertOversizedReport(t *testing.T, body []byte) {
	t.Helper()
	var report reportBody
	require.NoError(t, json.Unmarshal(body, &report))
	const wantTotal = 48 + 1
	require.Equal(t, uint32(wantTotal), report.Total)
	require.Equal(t, uint32(wantTotal), report.ErrorCount)
	require.Zero(t, report.WarningCount)
	require.Zero(t, report.InfoCount)
	require.True(t, report.Truncated)
	require.Len(t, report.Issues, checkwire.MaxIssues)
	require.Equal(t, "schema.widgets", report.Issues[0].RuleID)
}

// The dry run and the save share one slot pool. A full pool refuses new work with
// the same 429 and retry hint the other Insights endpoints use, and frees again
// once a slot is released. An unchecked save is not counted against the pool.
func TestDryRunAndCheckedSavesAreRefusedWhenSlotsAreFull(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	for range cap(s.checkSlots) {
		s.checkSlots <- struct{}{}
	}
	document := dashboard("demo", "Clean")
	for name, call := range map[string]func() *httptest.ResponseRecorder{
		"dry run": func() *httptest.ResponseRecorder {
			return request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
		},
		"checked save": func() *httptest.ResponseRecorder {
			return request(t, h, "PUT", "/api/dashboards/demo?checks=true", document, map[string]string{"If-None-Match": "*"})
		},
	} {
		w := call()
		require.Equal(t, http.StatusTooManyRequests, w.Code, "%s body %s", name, w.Body)
		require.Equal(t, "1", w.Header().Get("Retry-After"), name)
		require.Contains(t, w.Body.String(), "retry shortly", name)
	}
	plain := request(t, h, "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, plain.Code, "an unchecked save is not capped: %s", plain.Body)

	for range cap(s.checkSlots) {
		<-s.checkSlots
	}
	require.Equal(t, http.StatusOK, request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil).Code)
}

// A finding set holds at most the cap of widget findings, counts the rest exactly,
// and reports document-level findings first, as capCheckReport always did.
func TestFindingSetKeepsTheCapAndCountsTheRest(t *testing.T) {
	set := newFindingSet(checkwire.MaxIssues)
	set.add(&insightsv1.CheckFinding{RuleId: ruleWidgets, Severity: insightsv1.Severity_SEVERITY_ERROR, Pointer: "/widgets"})
	for i := range 100 {
		set.add(&insightsv1.CheckFinding{RuleId: ruleWidgetLayout, Severity: insightsv1.Severity_SEVERITY_ERROR, Pointer: widgetBase(i) + "/layout"})
	}
	for range 3 {
		set.add(&insightsv1.CheckFinding{RuleId: "layout.hole", Severity: insightsv1.Severity_SEVERITY_WARNING, Pointer: "/widgets/0/layout/y"})
	}
	require.Len(t, set.list, 1+checkwire.MaxIssues, "only the cap of widget findings is materialised")
	report := set.report()
	require.Len(t, report.GetIssues(), checkwire.MaxIssues)
	require.Equal(t, "/widgets", report.GetIssues()[0].GetPointer(), "document-level findings come first")
	require.Equal(t, uint32(104), report.GetTotal())
	require.Equal(t, uint32(101), report.GetErrorCount())
	require.Equal(t, uint32(3), report.GetWarningCount())
	require.True(t, report.GetTruncated())
	require.Equal(t, ruleWidgets, set.first.GetRuleId(), "the first finding is the save error")
}
