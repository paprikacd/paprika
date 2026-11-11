package insights

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// widgetJSON builds one widget object. The extra fragment is spliced into the
// object, so a test can override a field or add options.
func widgetJSON(id, layout, extra string) string {
	if layout == "" {
		layout = `{"x":0,"y":0,"w":6,"h":4}`
	}
	fragment := ""
	if extra != "" {
		fragment = "," + extra
	}
	return fmt.Sprintf(`{"id":%q,"title":%q,"type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":%s%s}`, id, "Widget "+id, layout, fragment)
}

func documentWithWidgets(id string, widgets ...string) Dashboard {
	return json.RawMessage(fmt.Sprintf(`{"schemaVersion":1,"id":%q,"title":"Checks","timeRange":"1h","refreshInterval":30,"widgets":[%s]}`, id, strings.Join(widgets, ",")))
}

func findingsFor(t *testing.T, document Dashboard) []json.RawMessage {
	t.Helper()
	findings := schemaFindings("demo", document)
	out := make([]json.RawMessage, 0, len(findings))
	for _, f := range findings {
		data, err := checkJSON.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, data)
	}
	return out
}

func TestSchemaFindingsPointNestedOptionsAtTheirPath(t *testing.T) {
	thresholds := `"options":{"thresholds":[{"value":10,"color":"#111111"},{"value":20,"color":"red"}]}`
	document := documentWithWidgets("demo", widgetJSON("requests", "", ""), widgetJSON("latency", "", thresholds))
	findings := schemaFindings("demo", document)
	if len(findings) != 1 {
		t.Fatalf("findings = %d, want 1", len(findings))
	}
	got := findings[0]
	if got.GetPointer() != "/widgets/1/options/thresholds/1" {
		t.Fatalf("pointer = %q", got.GetPointer())
	}
	if got.GetWidgetId() != "latency" || got.GetRuleId() != "schema.widget.options" {
		t.Fatalf("widget or rule = %q %q", got.GetWidgetId(), got.GetRuleId())
	}
	if got.GetMessage() != "thresholds require increasing finite values, hex colors, and labels up to 80 characters" {
		t.Fatalf("message = %q", got.GetMessage())
	}
	if validateDashboard("demo", document).Error() != got.GetMessage() {
		t.Fatalf("first error must match the save error: %v", validateDashboard("demo", document))
	}

	statBar := `"options":{"showStatBar":true,"max":100}`
	findings = schemaFindings("demo", documentWithWidgets("demo", widgetJSON("usage", "", statBar)))
	if len(findings) != 1 || findings[0].GetPointer() != "/widgets/0/options/showStatBar" {
		t.Fatalf("stat bar finding = %v", findings)
	}
}

func TestSchemaFindingsNameWidgetLayoutAndDuplicateIDs(t *testing.T) {
	document := documentWithWidgets("demo", widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, ""), widgetJSON("requests", "", ""))
	findings := schemaFindings("demo", document)
	if len(findings) != 2 {
		t.Fatalf("findings = %d, want 2", len(findings))
	}
	layout := findings[0]
	if layout.GetPointer() != "/widgets/0/layout" || layout.GetRuleId() != "schema.widget.layout" || layout.GetFix() == "" {
		t.Fatalf("layout finding = %+v", layout)
	}
	duplicate := findings[1]
	if duplicate.GetPointer() != "/widgets/1/id" || duplicate.GetMessage() != "widget ids must be valid and unique" || duplicate.GetRuleId() != "schema.widget.id" {
		t.Fatalf("duplicate finding = %+v", duplicate)
	}
}

func TestSchemaFindingsStopAtDocumentLevelFailures(t *testing.T) {
	document := json.RawMessage(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"2y","refreshInterval":30,"widgets":[]}`)
	findings := schemaFindings("demo", document)
	if len(findings) != 1 || findings[0].GetPointer() != "/timeRange" || findings[0].GetRuleId() != "schema.document.timeRange" {
		t.Fatalf("time range finding = %v", findings)
	}
	unknown := json.RawMessage(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,"widgets":[],"extra":true}`)
	findings = schemaFindings("demo", unknown)
	if len(findings) != 1 || findings[0].GetPointer() != "" || findings[0].GetRuleId() != "schema.document" {
		t.Fatalf("unknown field finding = %v", findings)
	}
}

func TestSchemaFindingsKeepReportedKeysBounded(t *testing.T) {
	longKey := strings.Repeat("k", 4000)
	document := documentWithWidgets("demo", widgetJSON("requests", "", fmt.Sprintf(`%q:true`, longKey)))
	findings := schemaFindings("demo", document)
	if len(findings) != 1 {
		t.Fatalf("findings = %d", len(findings))
	}
	got := findings[0]
	if len([]rune(got.GetMessage())) > maxFindingMessageRunes {
		t.Fatalf("message length = %d", len([]rune(got.GetMessage())))
	}
	if len(got.GetPointer()) > maxFindingPointerBytes || got.GetRuleId() != "schema.widget" {
		t.Fatalf("pointer = %d bytes, rule = %q", len(got.GetPointer()), got.GetRuleId())
	}
}

func TestSchemaFindingsCapReportAtThirtyTwo(t *testing.T) {
	widgets := make([]string, 0, 40)
	for i := range 40 {
		widgets = append(widgets, widgetJSON(fmt.Sprintf("w%02d", i), `{"x":0,"y":0,"w":0,"h":4}`, ""))
	}
	document := documentWithWidgets("demo", widgets...)
	findings := schemaFindings("demo", document)
	if len(findings) != 40 {
		t.Fatalf("collected %d findings, want 40", len(findings))
	}
	report := capCheckReport(findings)
	if len(report.GetFindings()) != maxCheckFindings || report.GetTotal() != 40 || !report.GetTruncated() {
		t.Fatalf("report = %d findings, total %d, truncated %t", len(report.GetFindings()), report.GetTotal(), report.GetTruncated())
	}
	if report.GetFindings()[31].GetWidgetId() != "w31" {
		t.Fatalf("cap must keep the first findings in order")
	}
}

func TestRuleForPointerNamesOnlyKnownFields(t *testing.T) {
	for pointer, want := range map[string]string{
		"":                      "schema.document",
		"/widgets":              "schema.widgets",
		"/widgets/3":            "schema.widget",
		"/widgets/3/layout":     "schema.widget.layout",
		"/widgets/3/options/x":  "schema.widget.options",
		"/widgets/3/invented":   "schema.widget",
		"/timeRange":            "schema.document.timeRange",
		"/invented":             "schema.document",
		"/widgets/3/quoted/\"x": "schema.widget",
	} {
		if got := ruleForPointer(pointer); got != want {
			t.Errorf("ruleForPointer(%q) = %q, want %q", pointer, got, want)
		}
	}
	if got := escapePointerToken("a/b~c"); got != "a~1b~0c" {
		t.Fatalf("escapePointerToken = %q", got)
	}
}

func TestSchemaFindingJSONUsesStringEnumsAndCamelCase(t *testing.T) {
	findings := findingsFor(t, documentWithWidgets("demo", widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, "")))
	if len(findings) != 1 {
		t.Fatalf("findings = %d", len(findings))
	}
	var fields map[string]any
	if err := json.Unmarshal(findings[0], &fields); err != nil {
		t.Fatal(err)
	}
	if fields["severity"] != "SEVERITY_ERROR" || fields["source"] != "SOURCE_SCHEMA" || fields["ruleId"] != "schema.widget.layout" || fields["widgetId"] != "requests" {
		t.Fatalf("finding JSON = %s", findings[0])
	}
}

type rejectedSaveBody struct {
	Error  string           `json:"error"`
	Issues []map[string]any `json:"issues"`
	Total  uint32           `json:"total"`
}

func TestDashboardSaveRejectionCarriesBoundedIssues(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	widgets := make([]string, 0, 40)
	for i := range 40 {
		widgets = append(widgets, widgetJSON(fmt.Sprintf("w%02d", i), `{"x":0,"y":0,"w":0,"h":4}`, ""))
	}
	w := request(t, h, "PUT", "/api/dashboards/demo", documentWithWidgets("demo", widgets...), map[string]string{"If-None-Match": "*"})
	if w.Code != 400 {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	var body rejectedSaveBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != "widget layout is outside the dashboard grid" || body.Total != 40 || len(body.Issues) != maxCheckFindings {
		t.Fatalf("body = error %q total %d issues %d", body.Error, body.Total, len(body.Issues))
	}
	first := body.Issues[0]
	if first["pointer"] != "/widgets/0/layout" || first["widgetId"] != "w00" || first["severity"] != "SEVERITY_ERROR" || first["source"] != "SOURCE_SCHEMA" {
		t.Fatalf("first issue = %v", first)
	}
	if _, _, err := store.Get("demo"); err == nil {
		t.Fatal("rejected save persisted a dashboard")
	}

	nested := documentWithWidgets("demo", widgetJSON("latency", "", `"options":{"thresholds":[{"value":10,"color":"#111111"},{"value":20,"color":"red"}]}`))
	w = request(t, h, "PUT", "/api/dashboards/demo", nested, map[string]string{"If-None-Match": "*"})
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 400 {
		t.Fatalf("nested status %d body %s err %v", w.Code, w.Body, err)
	}
	if len(body.Issues) != 1 || body.Issues[0]["pointer"] != "/widgets/0/options/thresholds/1" || body.Total != 1 {
		t.Fatalf("nested body = %+v", body)
	}
}

func TestDashboardValidateEndpointIsReadOnlyDryRun(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	if w := request(t, h, "POST", "/api/dashboards/validate", documentWithWidgets("demo"), map[string]string{"Authorization": "Bearer wrong"}); w.Code != 401 {
		t.Fatalf("unauthenticated validate returned %d", w.Code)
	}
	if w := request(t, h, "POST", "/api/dashboards/validate", []byte(`{"id":`), nil); w.Code != 400 {
		t.Fatalf("malformed validate returned %d", w.Code)
	}

	invalid := documentWithWidgets("demo", widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, ""))
	w := request(t, h, "POST", "/api/dashboards/validate", invalid, nil)
	if w.Code != 200 {
		t.Fatalf("invalid dry run status = %d, body %s", w.Code, w.Body)
	}
	var report struct {
		Findings  []map[string]any `json:"findings"`
		Total     uint32           `json:"total"`
		Truncated bool             `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Findings) != 1 || report.Findings[0]["pointer"] != "/widgets/0/layout" || report.Total != 1 || report.Truncated {
		t.Fatalf("report = %s", w.Body)
	}
	if got := store.List(); len(got) != 0 {
		t.Fatalf("validate wrote %d dashboards", len(got))
	}
	if missing := request(t, h, "GET", "/api/dashboards/demo", nil, nil); missing.Code != 404 {
		t.Fatalf("validate created a dashboard: %d", missing.Code)
	}

	w = request(t, h, "POST", "/api/dashboards/validate", dashboard("demo", "Demo"), nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"findings":[]`) || !strings.Contains(w.Body.String(), `"total":0`) {
		t.Fatalf("valid dry run = %d %s", w.Code, w.Body)
	}

	created := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Original"), map[string]string{"If-None-Match": "*"})
	if created.Code != 200 {
		t.Fatalf("create = %d", created.Code)
	}
	if w := request(t, h, "POST", "/api/dashboards/validate", dashboard("demo", "Changed"), nil); w.Code != 200 {
		t.Fatalf("validate existing = %d", w.Code)
	}
	doc, _, err := store.Get("demo")
	if err != nil || !strings.Contains(string(doc), "Original") {
		t.Fatalf("validate changed the stored dashboard: %s %v", doc, err)
	}
}
