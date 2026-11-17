package checkwire

import insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"

// SeverityCounts tallies findings by severity. Findings without a severity are
// not counted.
type SeverityCounts struct {
	Errors   uint32
	Warnings uint32
	Infos    uint32
}

// CountSeverities counts every finding it is given, so callers can count before
// they cap a list.
func CountSeverities(findings []*insightsv1.CheckFinding) SeverityCounts {
	var counts SeverityCounts
	for _, finding := range findings {
		switch finding.GetSeverity() {
		case insightsv1.Severity_SEVERITY_ERROR:
			counts.Errors++
		case insightsv1.Severity_SEVERITY_WARNING:
			counts.Warnings++
		case insightsv1.Severity_SEVERITY_INFO:
			counts.Infos++
		case insightsv1.Severity_SEVERITY_UNSPECIFIED:
		}
	}
	return counts
}
