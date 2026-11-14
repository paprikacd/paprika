package insights

import (
	"math"
	"strings"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// unboundedFindings keeps every widget finding. The store and the lint command
// read the full list; a request never does.
const unboundedFindings = math.MaxInt

// findingSet collects the findings of one check. It keeps every document-level
// finding and at most keep widget findings, and it counts all of them, so a
// report's total and severity counts are exact while only a bounded list is
// built. The first finding added is the one a rejected save reports.
type findingSet struct {
	keep       int
	list       []*insightsv1.CheckFinding
	widgetKept int
	first      *insightsv1.CheckFinding
	total      int
	errors     int
	warnings   int
	infos      int
}

func newFindingSet(keep int) *findingSet {
	return &findingSet{keep: keep}
}

func (s *findingSet) add(finding *insightsv1.CheckFinding) {
	if s.first == nil {
		s.first = finding
	}
	s.total++
	switch finding.GetSeverity() {
	case insightsv1.Severity_SEVERITY_ERROR:
		s.errors++
	case insightsv1.Severity_SEVERITY_WARNING:
		s.warnings++
	case insightsv1.Severity_SEVERITY_INFO:
		s.infos++
	case insightsv1.Severity_SEVERITY_UNSPECIFIED:
	}
	if !isWidgetFinding(finding) {
		s.list = append(s.list, finding)
		return
	}
	if s.widgetKept < s.keep {
		s.widgetKept++
		s.list = append(s.list, finding)
	}
}

// isWidgetFinding reports whether a finding names a widget. Document-level
// findings are kept in full, because there are only a few of them.
func isWidgetFinding(finding *insightsv1.CheckFinding) bool {
	return strings.HasPrefix(finding.GetPointer(), "/widgets/")
}

// hasErrors reports whether any finding is error severity, which rejects a save.
func (s *findingSet) hasErrors() bool {
	return s.errors > 0
}

// findings returns the kept findings in the order they were added.
func (s *findingSet) findings() []*insightsv1.CheckFinding {
	return s.list
}

// report is the check report for the set: document-level findings first, at most
// checkwire.MaxIssues issues, and counts that cover every finding added.
func (s *findingSet) report() *insightsv1.CheckReport {
	ordered := documentFirst(s.list)
	report := &insightsv1.CheckReport{
		Total:        checkwire.Count(s.total),
		ErrorCount:   checkwire.Count(s.errors),
		WarningCount: checkwire.Count(s.warnings),
		InfoCount:    checkwire.Count(s.infos),
		Truncated:    s.total > checkwire.MaxIssues,
	}
	if len(ordered) > checkwire.MaxIssues {
		ordered = ordered[:checkwire.MaxIssues]
	}
	report.Issues = ordered
	return report
}
