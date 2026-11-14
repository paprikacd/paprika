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

// oversizedMemberDocument builds a document whose named array member holds n copies
// of element. The widgets array is empty, so the member is the only problem a
// request can make large.
func oversizedMemberDocument(member string, n int, element string) Dashboard {
	var b strings.Builder
	b.WriteString(`{"schemaVersion":1,"id":"demo","title":"Big","timeRange":"1h","refreshInterval":30,"widgets":[],"` + member + `":[`)
	for i := range n {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(element)
	}
	b.WriteString("]}")
	return Dashboard(b.String())
}

// Every array a request can make large is read at a bounded cost: the widgets
// array, the variables array, and a dry run that asks for execute.
func TestOversizedArraysStayWithinAllocationBudget(t *testing.T) {
	// Each case names the report it must produce: the total, and the rule of the first issue.
	cases := map[string]struct {
		document  Dashboard
		wantTotal uint32
		wantRule  string
	}{
		"widgets of objects":   {oversizedWidgetsDocument(87000, "{}"), 48 + 1, "schema.widgets"},
		"widgets of numbers":   {oversizedWidgetsDocument(131000, "1"), 48 + 1, "schema.widgets"},
		"variables of objects": {oversizedMemberDocument("variables", 87000, "{}"), 1, "schema.document.variables"},
		"variables of numbers": {oversizedMemberDocument("variables", 131000, "1"), 1, "schema.document.variables"},
	}
	for name, tc := range cases {
		document := tc.document
		t.Run(name, func(t *testing.T) {
			s, _ := testService(t)
			h := s.Handler()
			require.LessOrEqual(t, len(document), maxDocumentBytes)
			// Build the request bodies before measuring, so only the service's work counts.
			dryRun := checkBody(document)
			executed := []byte(`{"document":` + string(document) + `,"execute":true}`)
			saved := []byte(document)

			w, allocated := measured(t, func() *httptest.ResponseRecorder {
				return request(t, h, "POST", "/api/dashboards/validate", dryRun, nil)
			})
			require.Equal(t, http.StatusOK, w.Code, "dry run body %.200s", w.Body)
			require.Less(t, allocated, uint64(16<<20), "dry run allocated too much")
			assertRejectedReport(t, w.Body.Bytes(), tc.wantTotal, tc.wantRule)

			w, allocated = measured(t, func() *httptest.ResponseRecorder {
				return request(t, h, "POST", "/api/dashboards/validate", executed, nil)
			})
			require.Equal(t, http.StatusOK, w.Code, "executed dry run body %.200s", w.Body)
			require.Less(t, allocated, uint64(16<<20), "executed dry run allocated too much")
			assertRejectedReport(t, w.Body.Bytes(), tc.wantTotal, tc.wantRule)

			w, allocated = measured(t, func() *httptest.ResponseRecorder {
				return request(t, h, "PUT", "/api/dashboards/demo?checks=true", saved, map[string]string{"If-None-Match": "*"})
			})
			require.Equal(t, http.StatusBadRequest, w.Code, "save body %.200s", w.Body)
			require.Less(t, allocated, uint64(16<<20), "save allocated too much")
			assertRejectedReport(t, w.Body.Bytes(), tc.wantTotal, tc.wantRule)
		})
	}
}

// measured runs call and returns its response with the bytes the process allocated
// while it ran.
func measured(t *testing.T, call func() *httptest.ResponseRecorder) (*httptest.ResponseRecorder, uint64) {
	t.Helper()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	w := call()
	runtime.ReadMemStats(&after)
	return w, after.TotalAlloc - before.TotalAlloc
}

// assertRejectedReport checks a report of an oversized request: its total, its error
// count, and the rule of its first issue, which the report lists first.
func assertRejectedReport(t *testing.T, body []byte, wantTotal uint32, wantRule string) {
	t.Helper()
	var report reportBody
	require.NoError(t, json.Unmarshal(body, &report))
	require.Equal(t, wantTotal, report.Total)
	require.Equal(t, wantTotal, report.ErrorCount)
	require.Zero(t, report.WarningCount)
	require.Zero(t, report.InfoCount)
	require.NotEmpty(t, report.Issues)
	require.Equal(t, wantRule, report.Issues[0].RuleID)
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
// and reports document-level findings first.
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

// A finding that names a member the document does not hold is anchored to its
// nearest ancestor the document holds. Duplicate members resolve to the last one,
// as a decoded value does, and an escaped member name is matched by its key.
func TestAnchorFindingsNamesTheNearestHeldNode(t *testing.T) {
	document := Dashboard(`{"a/b":{"c":1},"list":[{"x":1},null],"dup":{"gone":1},"dup":{"kept":2},"widgets":[]}`)
	pointers := []string{
		"",
		"/a~1b",
		"/a~1b/c",
		"/a~1b/missing",
		"/list/0/x",
		"/list/1/x",
		"/list/9",
		"/dup/gone",
		"/dup/kept",
		"/widgets/0/layout",
	}
	want := []string{"", "/a~1b", "/a~1b/c", "/a~1b", "/list/0/x", "/list/1", "/list", "/dup", "/dup/kept", "/widgets"}
	findings := make([]*insightsv1.CheckFinding, len(pointers))
	for i, pointer := range pointers {
		findings[i] = &insightsv1.CheckFinding{Pointer: pointer}
	}
	anchorFindings(document, findings)
	for i, finding := range findings {
		require.Equal(t, want[i], finding.GetPointer(), "pointer %q", pointers[i])
	}
}

// A document that is not JSON keeps the pointers its findings were given.
func TestAnchorFindingsLeavesANonJSONDocumentAlone(t *testing.T) {
	findings := []*insightsv1.CheckFinding{{Pointer: "/title"}}
	anchorFindings(Dashboard(`{"title":`), findings)
	require.Equal(t, "/title", findings[0].GetPointer())
}
