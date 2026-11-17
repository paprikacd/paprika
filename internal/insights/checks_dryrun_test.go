package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// The dry run must say what a save of the same document says. Each case here
// was reported differently before: the dry run answered with the id check while
// a save reported the structure.
func TestDryRunReportsWhatASaveReports(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	valid := string(dashboard("demo", "Demo"))
	for name, document := range map[string]string{
		"array document":   `[]`,
		"string document":  `"nope"`,
		"missing id":       strings.Replace(valid, `"id":"demo",`, ``, 1),
		"numeric id":       strings.Replace(valid, `"id":"demo"`, `"id":5`, 1),
		"unknown field":    strings.Replace(valid, `"schemaVersion":1,`, `"schemaVersion":1,"extra":true,`, 1),
		"bad time range":   strings.Replace(valid, `"timeRange":"1h"`, `"timeRange":"2y"`, 1),
		"duplicate widget": strings.Replace(valid, `"widgets":[`, `"widgets":[`+widgetJSON("requests", "", "")+`,`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			save := request(t, h, "PUT", "/api/dashboards/demo", []byte(document), map[string]string{"If-None-Match": "*"})
			if save.Code != http.StatusBadRequest {
				t.Fatalf("save of %s returned %d: %s", name, save.Code, save.Body)
			}
			var saved rejectedSaveBody
			if err := json.Unmarshal(save.Body.Bytes(), &saved); err != nil {
				t.Fatal(err)
			}
			dry := request(t, h, "POST", "/api/dashboards/validate", checkBody(json.RawMessage(document)), nil)
			if dry.Code != http.StatusOK {
				t.Fatalf("dry run of %s returned %d: %s", name, dry.Code, dry.Body)
			}
			var report struct {
				Issues []map[string]any `json:"issues"`
			}
			if err := json.Unmarshal(dry.Body.Bytes(), &report); err != nil {
				t.Fatal(err)
			}
			if len(report.Issues) == 0 || report.Issues[0]["message"] != saved.Error {
				t.Fatalf("dry run = %v, save error = %q", report.Issues, saved.Error)
			}
		})
	}
}

// A count failure is document-level, so it leads the issue list even when many
// widgets also fail. The save's error string is still the first validation message.
func TestDocumentLevelFindingLeadsTheIssueList(t *testing.T) {
	widgets := make([]string, 0, 60)
	for i := range 60 {
		extra := ""
		if i < 40 {
			extra = `"unknownField":true`
		}
		widgets = append(widgets, widgetJSON(fmt.Sprintf("w%02d", i), "", extra))
	}
	document := documentWithWidgets("demo", widgets...)
	s, _ := testService(t)
	dry := request(t, s.Handler(), "POST", "/api/dashboards/validate", checkBody(document), nil)
	var report struct {
		Issues    []map[string]any `json:"issues"`
		Total     uint32           `json:"total"`
		Truncated bool             `json:"truncated"`
	}
	if err := json.Unmarshal(dry.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Issues[0]["ruleId"] != "schema.widgets" || report.Issues[0]["pointer"] != "/widgets" {
		t.Fatalf("first issue = %v", report.Issues[0])
	}
	if len(report.Issues) != checkwire.MaxIssues || report.Total != 41 || !report.Truncated {
		t.Fatalf("report = %d issues, total %d, truncated %t", len(report.Issues), report.Total, report.Truncated)
	}

	save := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
	var saved rejectedSaveBody
	if err := json.Unmarshal(save.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Error != "unknown dashboard field \"unknownField\"" {
		t.Fatalf("save error changed: %q", saved.Error)
	}
	if saved.Issues[0]["ruleId"] != "schema.widgets" {
		t.Fatalf("save issues must lead with the count: %v", saved.Issues[0])
	}
}
