package insights

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benebsworth/paprika/internal/insights/checkwire"
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
		data, err := checkwire.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, data)
	}
	return out
}

func TestSchemaFindingsPointOptionFailuresAtTheirMember(t *testing.T) {
	thresholds := `"options":{"thresholds":[{"value":10,"color":"#111111"},{"value":20,"color":"red"}]}`
	document := documentWithWidgets("demo", widgetJSON("requests", "", ""), widgetJSON("latency", "", thresholds))
	findings := schemaFindings("demo", document)
	if len(findings) != 1 {
		t.Fatalf("findings = %d, want 1", len(findings))
	}
	got := findings[0]
	if got.GetPointer() != "/widgets/1/options/thresholds/1/color" || got.GetRuleId() != "schema.widget.options" || got.GetWidgetId() != "latency" {
		t.Fatalf("finding = pointer %q rule %q widget %q", got.GetPointer(), got.GetRuleId(), got.GetWidgetId())
	}
	if got.GetMessage() != "threshold color must be a six-digit hex color" {
		t.Fatalf("message = %q", got.GetMessage())
	}
	if validateDashboard("demo", document).Error() != got.GetMessage() {
		t.Fatalf("first error must match the save error: %v", validateDashboard("demo", document))
	}
}

func TestSchemaFindingsNameWidgetLayoutAndDuplicateIDs(t *testing.T) {
	document := documentWithWidgets("demo", widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, ""), widgetJSON("requests", "", ""))
	findings := schemaFindings("demo", document)
	if len(findings) != 2 {
		t.Fatalf("findings = %d, want 2", len(findings))
	}
	layout := findings[0]
	if layout.GetPointer() != "/widgets/0/layout/w" || layout.GetRuleId() != "schema.widget.layout" || layout.GetFix() == "" {
		t.Fatalf("layout finding = %+v", layout)
	}
	duplicate := findings[1]
	if duplicate.GetPointer() != "/widgets/1/id" || duplicate.GetMessage() != "widget ids must be valid and unique" || duplicate.GetRuleId() != "schema.widget.id" {
		t.Fatalf("duplicate finding = %+v", duplicate)
	}
}

// A broken shape in one widget must not hide the content checks on the others.
func TestSchemaFindingsReportEveryWidgetWhoseShapePasses(t *testing.T) {
	document := documentWithWidgets("demo",
		widgetJSON("a", "", `"options":{"decimals":99}`),
		widgetJSON("b", `{"x":0,"y":0,"w":0,"h":4}`, ""),
		widgetJSON("c", "", `"type":"bogus"`),
		widgetJSON("d", "", `"options":{"thresholds":[{"value":1}]},"unknownField":true`),
		widgetJSON("e", `{"x":0,"y":0,"w":13,"h":4}`, ""),
	)
	findings := schemaFindings("demo", document)
	type want struct{ pointer, rule string }
	// Shape failures come first, in widget order, so the first finding is the
	// one the save reported before; content findings follow for the other widgets.
	expected := []want{
		{"/widgets/0/options/decimals", "schema.widget.options"},
		{"/widgets/3/unknownField", "schema.widget.shape"},
		{"/widgets/1/layout/w", "schema.widget.layout"},
		{"/widgets/2/type", "schema.widget.type"},
		{"/widgets/4/layout/w", "schema.widget.layout"},
	}
	if len(findings) != len(expected) {
		t.Fatalf("findings = %d, want %d", len(findings), len(expected))
	}
	for i, w := range expected {
		if findings[i].GetPointer() != w.pointer || findings[i].GetRuleId() != w.rule {
			t.Fatalf("finding %d = pointer %q rule %q, want %q %q", i, findings[i].GetPointer(), findings[i].GetRuleId(), w.pointer, w.rule)
		}
	}
	if validateDashboard("demo", document).Error() != findings[0].GetMessage() {
		t.Fatalf("first finding must stay the save error")
	}
}

func TestSchemaFindingsAreDeterministic(t *testing.T) {
	document := documentWithWidgets("demo", widgetJSON("w", "", `"zeta":1,"alpha":2,"mid":3`))
	first := schemaFindings("demo", document)
	if len(first) != 1 || first[0].GetMessage() != `unknown dashboard field "alpha"` {
		t.Fatalf("first = %v", first)
	}
	for i := 0; i < 50; i++ {
		again := schemaFindings("demo", document)
		if again[0].GetMessage() != first[0].GetMessage() || again[0].GetPointer() != first[0].GetPointer() {
			t.Fatalf("finding changed between calls: %q", again[0].GetMessage())
		}
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
	if len(findings) != 1 || findings[0].GetPointer() != "/extra" || findings[0].GetRuleId() != "schema.document" {
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
	if got.GetPointer() != "/widgets/0" || got.GetRuleId() != "schema.widget.shape" {
		t.Fatalf("pointer %q rule %q", got.GetPointer(), got.GetRuleId())
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
	if len(report.GetIssues()) != checkwire.MaxIssues || report.GetTotal() != 40 || !report.GetTruncated() {
		t.Fatalf("report = %d findings, total %d, truncated %t", len(report.GetIssues()), report.GetTotal(), report.GetTruncated())
	}
	if report.GetIssues()[31].GetWidgetId() != "w31" {
		t.Fatalf("cap must keep the first findings in order")
	}
}

// adversarialDocument builds a document close to the 256 KiB limit that is
// expensive to check: long arrays inside options, thousands of unknown keys, and
// widgets that each fail in a different place.
func adversarialDocument(t *testing.T) Dashboard {
	t.Helper()
	var widgets []string
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("w%02d", i)
		switch i % 4 {
		case 0:
			widgets = append(widgets, widgetJSON(id, "", `"options":{"referenceLines":[`+zeroArray(2500)+`]}`))
		case 1:
			widgets = append(widgets, widgetJSON(id, "", `"options":{`+unknownKeyObject(600)+`}`))
		case 2:
			widgets = append(widgets, widgetJSON(id, `{"x":0,"y":0,"w":0,"h":4}`, `"options":{"thresholds":[`+zeroArray(1000)+`]}`))
		default:
			widgets = append(widgets, widgetJSON(id, "", `"options":{"decimals":99,"tags":[`+zeroArray(1000)+`]},"extra":{`+unknownKeyObject(600)+`}`))
		}
	}
	document := documentWithWidgets("demo", widgets...)
	if len(document) > maxDocumentBytes {
		t.Fatalf("adversarial document is %d bytes, over the %d limit", len(document), maxDocumentBytes)
	}
	if len(document) < maxDocumentBytes*9/10 {
		t.Fatalf("adversarial document is only %d bytes; it must sit near the %d limit", len(document), maxDocumentBytes)
	}
	return document
}

func zeroArray(n int) string {
	return strings.TrimSuffix(strings.Repeat("0,", n), ",")
}

func unknownKeyObject(n int) string {
	parts := make([]string, 0, n)
	for i := 0; i < n; i++ {
		parts = append(parts, fmt.Sprintf(`"key%05d":0`, i))
	}
	return strings.Join(parts, ",")
}

// Validation of the largest allowed document must stay cheap: the cost is linear
// in its size, so a hostile document cannot hold a request for long.
func TestSchemaFindingsCostIsBoundedForLargeDocuments(t *testing.T) {
	document := adversarialDocument(t)
	start := time.Now()
	findings := schemaFindings("demo", document)
	elapsed := time.Since(start)
	if len(findings) == 0 {
		t.Fatal("adversarial document must fail validation")
	}
	if elapsed > time.Second {
		t.Fatalf("validating a %d byte document took %s", len(document), elapsed)
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
	if body.Error != "widget layout is outside the dashboard grid" || body.Total != 40 || len(body.Issues) != checkwire.MaxIssues {
		t.Fatalf("body = error %q total %d issues %d", body.Error, body.Total, len(body.Issues))
	}
	first := body.Issues[0]
	if first["pointer"] != "/widgets/0/layout/w" || first["widgetId"] != "w00" || first["severity"] != "SEVERITY_ERROR" || first["source"] != "SOURCE_SCHEMA" {
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
	if len(body.Issues) != 1 || body.Issues[0]["pointer"] != "/widgets/0/options/thresholds/1/color" || body.Total != 1 {
		t.Fatalf("nested body = %+v", body)
	}
}

// checkBody wraps a document in the dry-run envelope.
func checkBody(document Dashboard) []byte {
	return []byte(`{"document":` + string(document) + `}`)
}

func TestDashboardValidateRejectsUnauthenticatedAndMalformedRequests(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	if w := request(t, h, "POST", "/api/dashboards/validate", checkBody(documentWithWidgets("demo")), map[string]string{"Authorization": "Bearer wrong"}); w.Code != 401 {
		t.Fatalf("unauthenticated validate returned %d", w.Code)
	}
	for name, body := range map[string]string{
		"malformed JSON":   `{"document":`,
		"bare document":    string(dashboard("demo", "Demo")),
		"missing document": `{}`,
		"unknown key":      `{"document":` + string(dashboard("demo", "Demo")) + `,"execute":true}`,
	} {
		if w := request(t, h, "POST", "/api/dashboards/validate", []byte(body), nil); w.Code != 400 {
			t.Fatalf("%s returned %d: %s", name, w.Code, w.Body)
		}
	}
}

func TestDashboardValidateIsAReadOnlyDryRun(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()

	// A document that is not an object is a finding, not a malformed request.
	if w := request(t, h, "POST", "/api/dashboards/validate", []byte(`{"document":"nope"}`), nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"ruleId":"schema.document"`) {
		t.Fatalf("non-object document = %d %s", w.Code, w.Body)
	}

	invalid := documentWithWidgets("demo", widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, ""))
	w := request(t, h, "POST", "/api/dashboards/validate", checkBody(invalid), nil)
	if w.Code != 200 {
		t.Fatalf("invalid dry run status = %d, body %s", w.Code, w.Body)
	}
	var report struct {
		Issues    []map[string]any `json:"issues"`
		Total     uint32           `json:"total"`
		Truncated bool             `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Issues) != 1 || report.Issues[0]["pointer"] != "/widgets/0/layout/w" || report.Total != 1 || report.Truncated {
		t.Fatalf("report = %s", w.Body)
	}
	again := request(t, h, "POST", "/api/dashboards/validate", checkBody(invalid), nil)
	if !bytes.Equal(w.Body.Bytes(), again.Body.Bytes()) {
		t.Fatalf("dry run bytes changed between identical calls:\n%s\n%s", w.Body, again.Body)
	}
	if got := store.List(); len(got) != 0 {
		t.Fatalf("validate wrote %d dashboards", len(got))
	}
	if missing := request(t, h, "GET", "/api/dashboards/demo", nil, nil); missing.Code != 404 {
		t.Fatalf("validate created a dashboard: %d", missing.Code)
	}

	w = request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Demo")), nil)
	if w.Code != 200 || w.Body.String() != `{"issues":[],"total":0,"truncated":false}` {
		t.Fatalf("valid dry run = %d %s", w.Code, w.Body)
	}

	created := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Original"), map[string]string{"If-None-Match": "*"})
	if created.Code != 200 {
		t.Fatalf("create = %d", created.Code)
	}
	if w := request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Changed")), nil); w.Code != 200 {
		t.Fatalf("validate existing = %d", w.Code)
	}
	doc, _, err := store.Get("demo")
	if err != nil || !strings.Contains(string(doc), "Original") {
		t.Fatalf("validate changed the stored dashboard: %s %v", doc, err)
	}
}

// The largest allowed document must cost little through both the dry run and a
// save, so a hostile body cannot hold the service for long.
func TestLargeDocumentIsCheapThroughDryRunAndSave(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := adversarialDocument(t)
	for name, call := range map[string]func() *httptest.ResponseRecorder{
		"dry run": func() *httptest.ResponseRecorder {
			return request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
		},
		"save": func() *httptest.ResponseRecorder {
			return request(t, h, "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
		},
	} {
		start := time.Now()
		w := call()
		elapsed := time.Since(start)
		if w.Code != 200 && w.Code != 400 {
			t.Fatalf("%s status = %d", name, w.Code)
		}
		if elapsed > time.Second {
			t.Fatalf("%s of a %d byte document took %s", name, len(document), elapsed)
		}
	}
}
